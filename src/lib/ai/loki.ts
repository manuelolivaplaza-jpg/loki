"use client";

/**
 * Cliente de Loki IA real (Edge Function `loki-chat` de Supabase).
 *
 * - `getLokiStatus()`: GET /health. Dice si hay proveedor configurado, sin
 *   exponer ninguna clave. Si la función no responde (p. ej. `sb:functions`
 *   apagado), se considera no configurada: la UI muestra "Loki IA sin
 *   configurar" en vez de romper.
 * - `streamLokiReply()`: POST con el JWT del usuario; la función responde con
 *   SSE real (`data: {"delta": "…"}` + `data: [DONE]`) y guarda la respuesta
 *   final con la service role. Aquí solo se acumula el texto para pintarlo en
 *   vivo; la fila persistida llega por realtime como cualquier mensaje.
 */

import { getSupabaseClient } from "@/lib/supabase/client";

export const LOKI_FUNCTION_PATH = "loki-chat";

/** Título cuando no hay proveedor: lo muestran /chat/loki-ia y el aviso. */
export const LOKI_NOT_CONFIGURED_TITLE = "Loki IA sin configurar";

/**
 * Aviso de sistema que inserta el cliente en un chat de espacio cuando se
 * menciona a @Loki sin proveedor configurado. Type "system" + autor propio:
 * es lo único escribible por el cliente (la RLS prohíbe type "ai" ahí).
 */
export const LOKI_NOT_CONFIGURED_SYSTEM_NOTICE =
  "Loki IA sin configurar. Pide al administrador que configure el proveedor.";

export type LokiHealth = {
  configured: boolean;
  provider: string;
  model: string;
};

const LOKI_OFFLINE: LokiHealth = {
  configured: false,
  provider: "none",
  model: "",
};

function functionUrl(): string | null {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/${LOKI_FUNCTION_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Estado del proveedor. Nunca lanza: sin función, sin configurar. */
export async function getLokiStatus(): Promise<LokiHealth> {
  const url = functionUrl();
  if (url === null) return LOKI_OFFLINE;
  try {
    const res = await fetch(`${url}/health`, { method: "GET" });
    if (!res.ok) return LOKI_OFFLINE;
    const body: unknown = await res.json();
    if (!isRecord(body)) return LOKI_OFFLINE;
    return {
      configured: body["configured"] === true,
      provider: typeof body["provider"] === "string" ? body["provider"] : "none",
      model: typeof body["model"] === "string" ? body["model"] : "",
    };
  } catch {
    return LOKI_OFFLINE;
  }
}

export type LokiStreamInput =
  | { mode: "personal"; text: string }
  | { mode: "mention"; text: string; workspaceId: string; chatId: string };

/** Error con mensaje ya en español para pintar en la UI. */
export class LokiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LokiError";
    this.code = code;
  }
}

/** Extrae el trozo de texto de una línea SSE (formato propio u OpenAI). */
function sseDelta(line: string): string | null {
  const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : null;
  if (payload === null || payload === "" || payload === "[DONE]") return null;
  try {
    const json: unknown = JSON.parse(payload);
    if (!isRecord(json)) return null;
    for (const key of ["delta", "text", "content"]) {
      if (typeof json[key] === "string") return json[key] as string;
    }
    // Forma OpenAI: choices[0].delta.content
    const choices = json["choices"];
    if (Array.isArray(choices)) {
      const first: unknown = choices[0];
      if (isRecord(first)) {
        const delta = first["delta"];
        if (isRecord(delta) && typeof delta["content"] === "string") {
          return delta["content"] as string;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Pide una respuesta a Loki IA y acumula el stream en `onChunk`.
 * Lanza `LokiError` en español (sesión, red o `not_configured`).
 */
export async function streamLokiReply(
  input: LokiStreamInput,
  onChunk: (fullText: string) => void,
): Promise<string> {
  const url = functionUrl();
  if (url === null) {
    throw new LokiError("not_configured", LOKI_NOT_CONFIGURED_TITLE);
  }
  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token ?? "";
  if (token === "") {
    throw new LokiError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new LokiError(
      "network",
      "Error de red. Revisa tu conexión e inténtalo de nuevo.",
    );
  }
  if (res.status === 503) {
    throw new LokiError("not_configured", LOKI_NOT_CONFIGURED_TITLE);
  }
  if (res.status === 401) {
    throw new LokiError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  if (!res.ok || res.body === null) {
    throw new LokiError(
      "failed",
      "Loki no pudo responder. Inténtalo de nuevo.",
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = sseDelta(line.trim());
      if (delta !== null && delta !== "") {
        full += delta;
        onChunk(full);
      }
    }
  }
  const tail = sseDelta(buffer.trim());
  if (tail !== null && tail !== "") {
    full += tail;
    onChunk(full);
  }
  return full;
}
