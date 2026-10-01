// =============================================================================
// Transcripción de audio · compartido por las Edge Functions (Deno).
//
// Sin dependencias externas: solo `fetch` y `FormData` (nativos del runtime).
// Configuración por entorno (`supabase/functions/.env`, gitignored):
//   STT_PROVIDER=openai|gemini   (cualquiera vacío = sin configurar)
//   STT_MODEL   modelo del proveedor (vacío = default)
//   STT_API_KEY clave (SOLO aquí)
//   STT_BASE_URL base de la API (solo openai-compatible; Gemini la ignora)
//
// Proveedores (documentación oficial revisada, sin inventar parámetros):
//   · openai (y compatibles: Groq, OpenRouter, Ollama, LM Studio…)
//     POST {base}/audio/transcriptions  ·  multipart: file, model, language,
//     response_format=json  ->  { text, language? }
//     https://platform.openai.com/docs/api-reference/audio/createTranscription
//   · gemini
//     POST {base}/v1beta/models/{model}:generateContent?key=…
//     contents[0].parts = [{ inline_data: { mime_type, data(base64) } }, { text }]
//     -> candidates[0].content.parts[].text
//     https://ai.google.dev/api/generate-content
//     https://ai.google.dev/gemini-api/docs/transcribe
//
// Sin `STT_API_KEY` (o proveedor desconocido) `isSttConfigured()` da false y la
// UI muestra "Transcripción sin configurar": nunca se rompe nada.
// =============================================================================

const PROVIDER = (Deno.env.get("STT_PROVIDER") ?? "").trim().toLowerCase();
const MODEL = (Deno.env.get("STT_MODEL") ?? "").trim();
const API_KEY = (Deno.env.get("STT_API_KEY") ?? "").trim();
const BASE_URL = (Deno.env.get("STT_BASE_URL") ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);

/** Base por defecto de Gemini si no se pone STT_BASE_URL. */
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/** Modelos por defecto del proveedor (ver enlaces arriba). */
const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini-transcribe",
  gemini: "gemini-2.0-flash",
};

/**
 * Formatos de audio que el cliente ya produce (MediaRecorder) más los típicos
 * de un archivo subido. Sirve para fallar rápido y con un mensaje en español
 * en vez de un HTTP 400 del proveedor.
 */
const SUPPORTED_MIME_PREFIXES: readonly string[] = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/m4a",
  "audio/flac",
  "audio/opus",
  "audio/webm;codecs=opus",
  "audio/webm;codecs=vp8",
  "audio/webm;codecs=vp9",
];

/** Tope defensivo: los buckets ya limitan, pero no vamos a subir de más. */
const MAX_BYTES = 25 * 1024 * 1024;

export type SttHealth = {
  configured: boolean;
  provider: string;
  model: string;
};

export type TranscribeInput = {
  /** Bytes del archivo de audio. */
  bytes: ArrayBuffer | Uint8Array;
  /** MIME del archivo (`audio/webm;codecs=opus`, `audio/mp4`, …). */
  mimeType: string;
  /** Nombre con extensión (el multipart lo exige). */
  filename: string;
  /** Idioma esperado en BCP-47 o ISO-639-1 (p. ej. "es"). Opcional. */
  language?: string | null;
  /** Duración en segundos, solo para Guardar el dato (no se manda). */
  durationSeconds?: number | null;
};

export type TranscribeResult = {
  text: string;
  /** Idioma detectado o hint, tal y como lo devuelve el proveedor. */
  language: string;
  provider: string;
  model: string;
};

/** Error con mensaje ya en español para la UI. */
export class SttError extends Error {
  readonly code: string;
  /** true = vale la pena reintentar (red o 5xx del proveedor). */
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SttError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ¿Hay proveedor de transcripción configurado? (sin exponer la clave) */
export function isSttConfigured(): boolean {
  return (
    API_KEY !== "" && (PROVIDER === "openai" || PROVIDER === "gemini")
  );
}

/** Estado para GET /health (no incluye la clave). */
export function sttHealth(): SttHealth {
  if (!isSttConfigured()) return { configured: false, provider: "none", model: "" };
  return {
    configured: true,
    provider: PROVIDER,
    model: MODEL !== "" ? MODEL : DEFAULT_MODEL[PROVIDER] ?? "",
  };
}

function providerModel(): string {
  return MODEL !== "" ? MODEL : DEFAULT_MODEL[PROVIDER] ?? "";
}

/**
 * Gemini ignora STT_BASE_URL salvo que se ponga explícitamente (el valor por
 * defecto es el de OpenAI). Mismo criterio que `completeFast` en el worker.
 */
function baseUrl(): string {
  if (PROVIDER !== "gemini") {
    return BASE_URL === "" ? OPENAI_DEFAULT_BASE : BASE_URL;
  }
  return BASE_URL === "" || BASE_URL === OPENAI_DEFAULT_BASE
    ? GEMINI_DEFAULT_BASE
    : BASE_URL;
}

function assertSupported(mimeType: string, byteLength: number): void {
  if (byteLength === 0) {
    throw new SttError("empty", "El audio está vacío.");
  }
  if (byteLength > MAX_BYTES) {
    throw new SttError("too_large", "El audio es demasiado largo para transcribir.");
  }
  const mime = mimeType.trim().toLowerCase();
  if (mime === "") return;
  // Se compara la parte base: "audio/webm;codecs=opus" es "audio/webm".
  const base = mime.split(";")[0]?.trim() ?? "";
  const ok = SUPPORTED_MIME_PREFIXES.some(
    (prefix) => base === prefix || base === prefix.split(";")[0],
  );
  if (!ok) {
    throw new SttError(
      "unsupported",
      "Ese formato de audio no se puede transcribir. Usa una nota de voz o un archivo de audio.",
    );
  }
}

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function base64From(bytes: Uint8Array): string {
  // `btoa` es binario: se agrupan los bytes de a 3 en base64 sin apilar.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

// --- OpenAI y compatibles ------------------------------------------------------

async function transcribeOpenAi(input: TranscribeInput): Promise<TranscribeResult> {
  const model = providerModel();
  const form = new FormData();
  const blob = new Blob([toUint8(input.bytes) as unknown as BlobPart], {
    type: input.mimeType !== "" ? input.mimeType : "application/octet-stream",
  });
  form.append("file", blob, input.filename);
  form.append("model", model);
  form.append("response_format", "json");
  const language = (input.language ?? "").trim();
  // `language` solo existe en whisper-1; los gpt-*-transcribe lo detectan solos
  // y mandarlo es un 400. Se manda solo si hay MODELO whisper.
  if (language !== "" && model.startsWith("whisper")) {
    form.append("language", language);
  }

  const res = await fetch(`${baseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new SttError("unauthorized", "Transcripción sin configurar.");
    }
    if (res.status === 400 || res.status === 413 || res.status === 415) {
      throw new SttError("bad_request", "El proveedor no pudo leer ese audio.");
    }
    throw new SttError(
      "provider",
      `El proveedor falló (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) {
    throw new SttError("provider", "El proveedor no devolvió transcripción.");
  }
  const text = typeof body["text"] === "string" ? body["text"].trim() : "";
  if (text === "") {
    throw new SttError("empty", "No se detectó voz en ese audio.");
  }
  const lang = typeof body["language"] === "string" ? body["language"] : language;
  return { text, language: lang, provider: "openai", model };
}

// --- Gemini --------------------------------------------------------------------

/** Prompt de transcripción literal: sin resumen, sin traducir, sin commentary. */
const GEMINI_PROMPT =
  "Transcribe literalmente el audio en español. " +
  "Devuelve SOLO el texto hablado, tal cual, sin comillas, sin encabezados, " +
  "sin explicar nada y sin traducir. Si no hay voz, devuelve una cadena vacía.";

async function transcribeGemini(input: TranscribeInput): Promise<TranscribeResult> {
  const model = providerModel();
  const data = base64From(toUint8(input.bytes));
  // Gemini acepta el MIME base: "audio/webm;codecs=opus" se vuelve
  // "audio/webm" (los codecs van dentro del archivo, no en el tipo).
  const mime = input.mimeType.split(";")[0]?.trim().toLowerCase() || "audio/mp4";
  const res = await fetch(
    `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mime, data } },
              { text: GEMINI_PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new SttError("unauthorized", "Transcripción sin configurar.");
    }
    if (res.status === 400) {
      throw new SttError("bad_request", "El proveedor no pudo leer ese audio.");
    }
    throw new SttError(
      "provider",
      `El proveedor falló (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body["candidates"])) {
    throw new SttError("provider", "El proveedor no devolvió transcripción.");
  }
  const first = body["candidates"][0];
  if (!isRecord(first) || !isRecord(first["content"])) {
    throw new SttError("provider", "El proveedor no devolvió transcripción.");
  }
  const parts = first["content"]["parts"];
  if (!Array.isArray(parts)) {
    throw new SttError("provider", "El proveedor no devolvió transcripción.");
  }
  const text = parts
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("")
    .trim();
  if (text === "") {
    throw new SttError("empty", "No se detectó voz en ese audio.");
  }
  return { text, language: input.language ?? "es", provider: "gemini", model };
}

/**
 * Transcribe un audio ya subido a Storage. Lanza `SttError` con mensaje en
 * español. Sin `STT_API_KEY` lanza `not_configured` (nunca una excepción rara).
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  if (!isSttConfigured()) {
    throw new SttError("not_configured", "Transcripción sin configurar.");
  }
  assertSupported(input.mimeType, input.bytes.byteLength);
  if (PROVIDER === "gemini") return transcribeGemini(input);
  return transcribeOpenAi(input);
}
