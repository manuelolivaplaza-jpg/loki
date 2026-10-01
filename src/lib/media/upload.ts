/**
 * Subida de adjuntos a Supabase Storage (sin dependencias nuevas).
 *
 * Buckets privados `chat-media` y `post-media` (ruta `{wsId}/{uuid}-{nombre}`):
 * la subida usa `XMLHttpRequest` contra la API de Storage con el token de la
 * sesión, así hay progreso REAL (`upload.onprogress`) y cancelación
 * (`xhr.abort()` vía `AbortSignal`). Después se firma una URL de lectura de
 * larga duración, que es lo que se guarda en el mensaje.
 *
 * Límites (los aplica el cliente con mensaje amable en español; ver la
 * migración `20260930000002_storage.sql`):
 * imagen/video/archivo 25 MB, audio 10 MB.
 */

"use client";

import { getSupabaseClient } from "@/lib/supabase/client";
import type { AttachmentKind, MessageAttachment } from "@/types/chat";
import { formatFileSize } from "@/lib/media/audio";

export type MediaBucket = "chat-media" | "post-media";

/** URL firmada válida un año (los mensajes viejos siguen abriendo). */
const SIGNED_URL_TTL_SECONDS = 365 * 24 * 3600;

export const MAX_IMAGE_VIDEO_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export type UploadedAttachment = MessageAttachment & { path: string };

export type UploadOptions = {
  bucket?: MediaBucket;
  /** Progreso real 0-100 (bytes enviados / total). */
  onProgress?: (percent: number) => void;
  /** Cancela la subida (el error resultante es `AbortError`). */
  signal?: AbortSignal;
};

/** Buckets donde se guardan los adjuntos. */
const MEDIA_BUCKETS: readonly MediaBucket[] = ["chat-media", "post-media"];

/**
 * Parte el `path` de un adjunto (`{bucket}/{wsId}/{uuid}-{nombre}`) en el
 * bucket y la ruta del objeto DENTRO del bucket (`{wsId}/{uuid}-{nombre}`).
 * Devuelve null si el path no tiene esa forma (mensajes viejos sin path, o
 * un adjunto que vino de otro sitio): quien llama avisa en vez de adivinar.
 */
export function splitMediaPath(
  path: string | undefined,
): { bucket: MediaBucket; objectPath: string; workspaceId: string } | null {
  if (path === undefined) return null;
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 3) return null;
  const bucket = parts[0];
  const workspaceId = parts[1];
  const objectPath = parts.slice(1).join("/");
  if (!MEDIA_BUCKETS.includes(bucket as MediaBucket)) return null;
  // El primer segmento DE LA RUTA es el espacio (helper storage_workspace_id
  // de la base); si no parece un uuid, no hay transcripción posible.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    return null;
  }
  return { bucket: bucket as MediaBucket, objectPath, workspaceId };
}

/** Clasifica un archivo por su MIME (sin MIME -> archivo genérico). */
export function kindFromFile(file: File): AttachmentKind {
  const mime = file.type.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Valida el tamaño según el tipo. Devuelve el mensaje amable en español o
 * null si cabe. El llamador lo muestra tal cual.
 */
export function validateFileSize(file: File): string | null {
  const kind = kindFromFile(file);
  const limit = kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_VIDEO_FILE_BYTES;
  if (file.size <= limit) return null;
  const maxMb = Math.round(limit / (1024 * 1024));
  return (
    `Ese archivo pesa mucho (${formatFileSize(file.size)}). ` +
    `El máximo es ${maxMb} MB.`
  );
}

/** Nombre seguro para la ruta de Storage (sin tildes ni raros). */
function safeFileName(name: string): string {
  const base = name.trim() === "" ? "archivo" : name.trim();
  const ascii = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");
  const clean = ascii === "" ? "archivo" : ascii;
  return clean.length > 80 ? clean.slice(-80) : clean;
}

function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = (): void => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        resolve(null);
      }
    };
    img.onerror = (): void => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function readMediaMeta(
  file: File,
): Promise<{ width?: number; height?: number; duration?: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.toLowerCase().startsWith("video/");
    const el = isVideo ? document.createElement("video") : document.createElement("audio");
    el.preload = "metadata";
    const done = (value: { width?: number; height?: number; duration?: number } | null): void => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.onloadedmetadata = (): void => {
      const out: { width?: number; height?: number; duration?: number } = {};
      if (isVideo) {
        const video = el as HTMLVideoElement;
        if (video.videoWidth > 0) out.width = video.videoWidth;
        if (video.videoHeight > 0) out.height = video.videoHeight;
      }
      if (Number.isFinite(el.duration) && el.duration > 0) {
        out.duration = el.duration;
      }
      done(out);
    };
    el.onerror = (): void => done(null);
    el.src = url;
  });
}

function uploadWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: ((percent: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event): void => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        let detail = "No se pudo subir el archivo.";
        try {
          const body = JSON.parse(xhr.responseText) as { message?: unknown; error?: unknown };
          if (typeof body.message === "string" && body.message !== "") {
            detail = body.message;
          } else if (typeof body.error === "string" && body.error !== "") {
            detail = body.error;
          }
        } catch {
          // Respuesta no JSON: se deja el mensaje genérico.
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = (): void => {
      reject(new Error("Sin conexión. Revisa tu red e inténtalo de nuevo."));
    };
    const onAbort = (): void => {
      xhr.abort();
      reject(new DOMException("Subida cancelada.", "AbortError"));
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    xhr.send(file);
  });
}

/**
 * Sube un archivo a `{bucket}/{wsId}/{uuid}-{nombre}` y devuelve el adjunto
 * listo para guardar en el mensaje. Lanza en español; la cancelación es un
 * `DOMException` con `name === "AbortError"` (el llamador la ignora en silencio).
 */
export async function uploadAttachment(
  wsId: string,
  file: File,
  options: UploadOptions = {},
): Promise<UploadedAttachment> {
  const bucket: MediaBucket = options.bucket ?? "chat-media";
  const tooBig = validateFileSize(file);
  if (tooBig !== null) throw new Error(tooBig);
  if (wsId.trim() === "") throw new Error("Elige un espacio para adjuntar.");

  const supabase = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError !== null || sessionData.session === null) {
    throw new Error("Inicia sesión para adjuntar archivos.");
  }
  const baseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (baseUrl === "" || anonKey === "") {
    throw new Error("Falta la configuración de Supabase.");
  }

  const kind = kindFromFile(file);
  const path = `${wsId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;

  // Metadatos locales (dimensiones/duración) antes de subir: no bloquean si fallan.
  let meta: { width?: number; height?: number; duration?: number } | null = null;
  try {
    meta =
      kind === "image"
        ? await readImageSize(file)
        : kind === "video" || kind === "audio"
          ? await readMediaMeta(file)
          : null;
  } catch {
    meta = null;
  }
  if (options.signal?.aborted === true) {
    throw new DOMException("Subida cancelada.", "AbortError");
  }

  await uploadWithProgress(
    `${baseUrl}/storage/v1/object/${bucket}/${path}`,
    {
      apikey: anonKey,
      Authorization: `Bearer ${sessionData.session.access_token}`,
      "Content-Type": file.type !== "" ? file.type : "application/octet-stream",
      "x-upsert": "false",
    },
    file,
    options.onProgress,
    options.signal,
  );

  const { data: signed, error: signedError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signedError !== null || signed === null || signed.signedUrl === "") {
    throw new Error("Se subió el archivo, pero no se pudo generar el enlace.");
  }

  const attachment: UploadedAttachment = {
    kind,
    url: signed.signedUrl,
    name: file.name !== "" ? file.name : "archivo",
    size: file.size,
    mime: file.type !== "" ? file.type : "application/octet-stream",
    path: `${bucket}/${path}`,
  };
  if (meta?.width !== undefined) attachment.width = meta.width;
  if (meta?.height !== undefined) attachment.height = meta.height;
  if (meta?.duration !== undefined) attachment.duration = meta.duration;
  return attachment;
}
