"use client";

/**
 * Cliente de Loki IA con herramientas (Edge Function `loki-chat`).
 *
 * - `sendLokiWithTools()`: primer POST; acumula el stream en `onChunk` y
 *   avisa con `onToolPending` si la respuesta trae una acción pendiente.
 * - `confirmLokiAction()`: segundo POST con `{ confirm: { id, action,
 *   params, ok } }`; ejecuta (ok=true) o descarta (ok=false) y sigue el
 *   stream con el resultado.
 *
 * Sin proveedor lanza `LokiError` "not_configured" (la UI reutiliza el aviso
 * "Loki IA sin configurar"); con cuota superada, "limit".
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import { edgeHeaders } from "@/lib/edge";
import {
  LOKI_FUNCTION_PATH,
  LOKI_NOT_CONFIGURED_TITLE,
  LokiError,
} from "@/lib/ai/loki";

/** Ítem de un plan multi-acción (protocolo tool_pending extendido). */
export type AiPendingItem = {
  action: string;
  label: string;
  params: Record<string, unknown>;
  include: boolean;
  warning?: string;
};

/** Persona candidata cuando "a Pedro" es ambiguo. */
export type AssigneeChoice = {
  uid: string;
  name: string;
};

/** Acción de escritura pendiente de confirmación (protocolo SSE). */
export type AiPendingAction = {
  id: string;
  action: string;
  label: string;
  params: Record<string, unknown>;
  /** Plan: una tarjeta con varias acciones (ausente = acción única, compatible). */
  actions?: AiPendingItem[];
  /** Elegir responsable cuando el nombre es ambiguo. */
  assigneeChoices?: AssigneeChoice[];
};

export type LokiConfirmItem = {
  action: string;
  params: Record<string, unknown>;
  include: boolean;
};

export type LokiConfirm = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  actions?: LokiConfirmItem[];
};

export type UndoItem = {
  kind: "task" | "event" | "post" | "list_item" | "series";
  id: string;
  label: string;
  workspaceId: string;
  projectId?: string;
};

export type CreatedResult = {
  links: string[];
  undo: UndoItem[];
};

export type LokiToolsInput =
  | { mode: "personal"; text: string }
  | {
    mode: "mention";
    text: string;
    workspaceId: string;
    chatId: string;
    threadParentId?: string;
  };

export type LokiConfirmInput =
  | { mode: "personal"; text?: string; confirm: LokiConfirm }
  | {
    mode: "mention";
    text?: string;
    workspaceId: string;
    chatId: string;
    threadParentId?: string;
    confirm: LokiConfirm;
  };

export type LokiToolsCallbacks = {
  onChunk: (fullText: string) => void;
  onToolPending?: (pending: AiPendingAction) => void;
  onCreated?: (created: CreatedResult) => void;
};

function functionUrl(): string | null {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/${LOKI_FUNCTION_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePendingItem(value: unknown): AiPendingItem | null {
  if (!isRecord(value)) return null;
  const action = value["action"];
  if (typeof action !== "string" || action === "") return null;
  const label = typeof value["label"] === "string" && value["label"] !== ""
    ? value["label"]
    : "Confirmar acción";
  const params = isRecord(value["params"]) ? value["params"] : {};
  const warning = typeof value["warning"] === "string" && value["warning"] !== ""
    ? value["warning"]
    : undefined;
  return {
    action,
    label,
    params,
    include: value["include"] !== false && warning === undefined,
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** Extrae una acción pendiente válida de un payload SSE (o null). */
function parsePending(value: unknown): AiPendingAction | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const action = value["action"];
  if (typeof id !== "string" || id === "" || typeof action !== "string" || action === "") {
    return null;
  }
  const label = typeof value["label"] === "string" && value["label"] !== ""
    ? value["label"]
    : "Confirmar acción";
  const params = isRecord(value["params"]) ? value["params"] : {};
  let actions: AiPendingItem[] | undefined;
  if (Array.isArray(value["actions"])) {
    const items = value["actions"]
      .map(parsePendingItem)
      .filter((item): item is AiPendingItem => item !== null)
      .slice(0, 10);
    if (items.length > 0) actions = items;
  }
  let assigneeChoices: AssigneeChoice[] | undefined;
  if (Array.isArray(value["assigneeChoices"])) {
    const choices: AssigneeChoice[] = [];
    for (const choice of value["assigneeChoices"]) {
      if (!isRecord(choice)) continue;
      const uid = choice["uid"];
      const name = choice["name"];
      if (typeof uid === "string" && uid !== "" && typeof name === "string") {
        choices.push({ uid, name });
      }
    }
    if (choices.length > 0) assigneeChoices = choices;
  }
  return {
    id,
    action,
    label,
    params,
    ...(actions !== undefined ? { actions } : {}),
    ...(assigneeChoices !== undefined ? { assigneeChoices } : {}),
  };
}

type SseOutcome = { text: string; pending: AiPendingAction | null };

/**
 * POST con SSE de la Edge: acumula `delta`, captura `tool_pending` y lanza
 * `LokiError` en español ante 401/429/503 o fallos de red.
 */
async function ssePost(
  payload: LokiToolsInput | LokiConfirmInput,
  callbacks: LokiToolsCallbacks,
): Promise<SseOutcome> {
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
      headers: edgeHeaders(token),
      body: JSON.stringify(payload),
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
  if (res.status === 429) {
    throw new LokiError(
      "limit",
      "Llegaste al límite diario de Loki IA. Vuelve mañana.",
    );
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
  let pending: AiPendingAction | null = null;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    const payloadText = trimmed.startsWith("data:")
      ? trimmed.slice("data:".length).trim()
      : null;
    if (payloadText === null || payloadText === "" || payloadText === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (typeof parsed["delta"] === "string" && parsed["delta"] !== "") {
      full += parsed["delta"] as string;
      callbacks.onChunk(full);
      return;
    }
    if (parsed["tool_pending"] !== undefined) {
      const next = parsePending(parsed["tool_pending"]);
      if (next !== null) {
        pending = next;
        callbacks.onToolPending?.(next);
      }
      return;
    }
    if (parsed["created"] !== undefined && isRecord(parsed["created"])) {
      const created = parsed["created"];
      const links = Array.isArray(created["links"])
        ? created["links"].filter((l): l is string => typeof l === "string")
        : [];
      const undo: UndoItem[] = [];
      if (Array.isArray(created["undo"])) {
        for (const entry of created["undo"]) {
          if (!isRecord(entry)) continue;
          const kind = entry["kind"];
          const id = entry["id"];
          const workspaceId = entry["workspaceId"];
          if (
            (kind === "task" ||
              kind === "event" ||
              kind === "post" ||
              kind === "list_item" ||
              kind === "series") &&
            typeof id === "string" && id !== "" &&
            typeof workspaceId === "string" && workspaceId !== ""
          ) {
            const item: UndoItem = {
              kind,
              id,
              label: typeof entry["label"] === "string" ? entry["label"] : "",
              workspaceId,
            };
            if (typeof entry["projectId"] === "string" && entry["projectId"] !== "") {
              item.projectId = entry["projectId"];
            }
            undo.push(item);
          }
        }
      }
      if (links.length > 0 || undo.length > 0) {
        callbacks.onCreated?.({ links, undo });
      }
      return;
    }
    if (typeof parsed["error"] === "string" && parsed["error"] !== "") {
      throw new LokiError("failed", "Loki no pudo responder. Inténtalo de nuevo.");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim() !== "") handleLine(buffer);
  return { text: full, pending };
}

/**
 * Primer POST: pide una respuesta (o propuesta de acción) a Loki IA.
 * Devuelve el texto acumulado y la acción pendiente, si hubo.
 */
export async function sendLokiWithTools(
  input: LokiToolsInput,
  callbacks: LokiToolsCallbacks,
): Promise<SseOutcome> {
  return ssePost(input, callbacks);
}

/**
 * Segundo POST: confirma (`ok: true`) o cancela (`ok: false`) la acción
 * pendiente y sigue el stream con el resultado ("Listo: …" o descarte).
 */
export async function confirmLokiAction(
  input: LokiConfirmInput,
  onChunk: (fullText: string) => void,
): Promise<string> {
  const outcome = await ssePost(input, { onChunk });
  return outcome.text;
}

export type ConvertSuggestion = {
  title: string;
  dateISO: string | null;
};

/**
 * "Mejorar con Loki": el modelo barato propone título y fecha para
 * convertir un mensaje. Nunca automático: solo sugiere.
 */
export async function suggestConvertTitle(text: string): Promise<ConvertSuggestion> {
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
      headers: edgeHeaders(token),
      body: JSON.stringify({ mode: "suggest", text: text.slice(0, 1000) }),
    });
  } catch {
    throw new LokiError("network", "Error de red. Revisa tu conexión e inténtalo de nuevo.");
  }
  if (res.status === 503) {
    throw new LokiError("not_configured", LOKI_NOT_CONFIGURED_TITLE);
  }
  if (res.status === 429) {
    throw new LokiError("limit", "Llegaste al límite diario de Loki IA. Vuelve mañana.");
  }
  if (!res.ok) {
    throw new LokiError("failed", "Loki no pudo sugerir. Inténtalo de nuevo.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) {
    throw new LokiError("failed", "Loki no pudo sugerir. Inténtalo de nuevo.");
  }
  return {
    title: typeof body["title"] === "string" ? body["title"].slice(0, 80) : "",
    dateISO: typeof body["dateISO"] === "string" ? body["dateISO"] : null,
  };
}
