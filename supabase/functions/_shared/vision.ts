// =============================================================================
// Texto en imágenes (OCR con el modelo de visión) · compartido por las Edge
// Functions (Deno).
//
// Sin dependencias externas: solo `fetch` (nativo del runtime).
// Configuración por entorno (`supabase/functions/.env`, gitignored):
//   OCR_PROVIDER=openai|anthropic|gemini  (vacío = se usa LLM_PROVIDER)
//   OCR_MODEL    modelo de visión         (vacío = LLM_MODEL o el default)
//   OCR_API_KEY  clave                    (vacía = se usa LLM_API_KEY)
//   OCR_BASE_URL base de la API          (vacía = se usa LLM_BASE_URL)
//
// Si no hay clave (ni OCR_API_KEY ni LLM_API_KEY), `isOcrConfigured()` da
// false: el worker marca la imagen como `skipped` y la UI la encuentra solo
// por nombre. Nunca se rompe nada.
//
// Proveedores (misma forma que el chat de cada uno, sin inventar parámetros):
//   · openai (y compatibles)  POST {base}/chat/completions con
//     content: [{type:"text"}, {type:"image_url", image_url:{url:data:…}}]
//   · anthropic               POST /v1/messages con
//     content: [{type:"image", source:{type:"base64"}}, {type:"text"}]
//   · gemini                  POST :generateContent con
//     parts: [{inline_data:{mime_type,data}}, {text}]
// =============================================================================

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

const LLM_PROVIDER = env("LLM_PROVIDER").toLowerCase();
const LLM_MODEL = env("LLM_MODEL");
const LLM_API_KEY = env("LLM_API_KEY");
const LLM_BASE_URL = env("LLM_BASE_URL").replace(/\/+$/, "");

const PROVIDER = (env("OCR_PROVIDER") || LLM_PROVIDER).toLowerCase();
const MODEL = env("OCR_MODEL") || LLM_MODEL;
const API_KEY = env("OCR_API_KEY") || LLM_API_KEY;
const BASE_URL = (env("OCR_BASE_URL") || LLM_BASE_URL || "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);

/** Base por defecto de Gemini si no se pone base explícita. */
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/** Modelos con visión por defecto (los baratos con imagen de cada casa). */
const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  gemini: "gemini-2.0-flash",
};

/** Tope defensivo: las imágenes del chat ya vienen acotadas a 25 MB. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Lo que los tres proveedores aceptan sin convertir. */
const SUPPORTED_MIME: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export type OcrHealth = {
  configured: boolean;
  provider: string;
  model: string;
};

export type OcrInput = {
  /** Bytes de la imagen. */
  bytes: ArrayBuffer | Uint8Array;
  /** MIME (`image/jpeg`, `image/png`, …). */
  mimeType: string;
};

export type OcrResult = {
  text: string;
  provider: string;
  model: string;
};

/** Error con mensaje ya en español para guardar en la fila. */
export class OcrError extends Error {
  readonly code: string;
  /** true = vale la pena reintentar (red o 5xx del proveedor). */
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ¿Hay modelo de visión configurado? (sin exponer la clave) */
export function isOcrConfigured(): boolean {
  return (
    API_KEY !== "" && (PROVIDER === "openai" || PROVIDER === "anthropic" || PROVIDER === "gemini")
  );
}

/** Estado para GET /health (no incluye la clave). */
export function ocrHealth(): OcrHealth {
  if (!isOcrConfigured()) return { configured: false, provider: "none", model: "" };
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
 * Gemini ignora la base salvo que se ponga explícitamente (el valor por
 * defecto es el de OpenAI). Mismo criterio que el resto del worker.
 */
function baseUrl(): string {
  if (PROVIDER !== "gemini") {
    return BASE_URL === "" ? OPENAI_DEFAULT_BASE : BASE_URL;
  }
  return BASE_URL === "" || BASE_URL === OPENAI_DEFAULT_BASE
    ? GEMINI_DEFAULT_BASE
    : BASE_URL;
}

function base64From(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Prompt de extracción literal: sin describir, sin inventar, sin adornos. */
const OCR_PROMPT =
  "Extrae TODO el texto visible en esta imagen, en su idioma original, " +
  "respetando el orden de lectura. Devuelve SOLO el texto, sin comillas, " +
  "sin encabezados y sin explicar nada. Si no hay texto legible, " +
  "devuelve una cadena vacía.";

function assertSupported(mimeType: string, byteLength: number): string {
  if (byteLength === 0) {
    throw new OcrError("empty", "La imagen está vacía.");
  }
  if (byteLength > MAX_BYTES) {
    throw new OcrError("too_large", "La imagen es demasiado pesada para leer su texto.");
  }
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (SUPPORTED_MIME.includes(mime)) return mime;
  // Fuera de la lista se intenta igual con el MIME declarado: el proveedor
  // dirá si no lo lee (mejor que adivinar conversiones sin librerías).
  if (mime.startsWith("image/")) return mime;
  throw new OcrError("unsupported", "Ese archivo no es una imagen legible.");
}

function joinTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("")
    .trim();
}

async function ocrOpenAi(input: OcrInput, mime: string): Promise<OcrResult> {
  const model = providerModel();
  const data = base64From(toUint8(input.bytes));
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new OcrError("unauthorized", "OCR sin configurar.");
    }
    if (res.status === 400 || res.status === 413 || res.status === 415) {
      throw new OcrError("bad_request", "El proveedor no pudo leer esa imagen.");
    }
    throw new OcrError(
      "provider",
      `El proveedor falló (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body["choices"])) {
    throw new OcrError("provider", "El proveedor no devolvió texto.");
  }
  const first = body["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) {
    throw new OcrError("provider", "El proveedor no devolvió texto.");
  }
  const content = first["message"]["content"];
  const text = typeof content === "string" ? content.trim() : joinTextParts(content);
  return { text, provider: "openai", model };
}

async function ocrAnthropic(input: OcrInput, mime: string): Promise<OcrResult> {
  const model = providerModel();
  const data = base64From(toUint8(input.bytes));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data } },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new OcrError("unauthorized", "OCR sin configurar.");
    }
    if (res.status === 400 || res.status === 413) {
      throw new OcrError("bad_request", "El proveedor no pudo leer esa imagen.");
    }
    throw new OcrError(
      "provider",
      `El proveedor falló (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body["content"])) {
    throw new OcrError("provider", "El proveedor no devolvió texto.");
  }
  return { text: joinTextParts(body["content"]), provider: "anthropic", model };
}

async function ocrGemini(input: OcrInput, mime: string): Promise<OcrResult> {
  const model = providerModel();
  const data = base64From(toUint8(input.bytes));
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
              { text: OCR_PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 1000 },
      }),
    },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new OcrError("unauthorized", "OCR sin configurar.");
    }
    if (res.status === 400) {
      throw new OcrError("bad_request", "El proveedor no pudo leer esa imagen.");
    }
    throw new OcrError(
      "provider",
      `El proveedor falló (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body["candidates"])) {
    throw new OcrError("provider", "El proveedor no devolvió texto.");
  }
  const first = body["candidates"][0];
  if (!isRecord(first) || !isRecord(first["content"])) {
    throw new OcrError("provider", "El proveedor no devolvió texto.");
  }
  return { text: joinTextParts(first["content"]["parts"]), provider: "gemini", model };
}

/**
 * Extrae el texto de una imagen ya subida a Storage. Lanza `OcrError` con
 * mensaje en español. Sin clave lanza `not_configured` (el worker marca la
 * imagen como `skipped`: se encuentra por nombre, sin reintentos).
 * Una imagen sin texto legible devuelve "" (no es error: queda `ready` con
 * texto vacío y no se vuelve a pagar).
 */
export async function extractImageText(input: OcrInput): Promise<OcrResult> {
  if (!isOcrConfigured()) {
    throw new OcrError("not_configured", "OCR sin configurar.");
  }
  const mime = assertSupported(input.mimeType, input.bytes.byteLength);
  if (PROVIDER === "anthropic") return ocrAnthropic(input, mime);
  if (PROVIDER === "gemini") return ocrGemini(input, mime);
  return ocrOpenAi(input, mime);
}
