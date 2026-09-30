/**
 * Ayudas de audio (notas de voz): MIME soportado y formato de duración.
 *
 * Sin dependencias: `MediaRecorder` y elementos `<audio>` del navegador.
 */

/** Elige el primer MIME de grabación que soporte el navegador. */
export function pickVoiceMimeType(): string {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Sigue con el siguiente candidato.
    }
  }
  return "";
}

/** Extensión acorde al MIME de la grabación (para el nombre del archivo). */
export function voiceExtension(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  return "webm";
}

/** Segundos -> "m:ss" (p. ej. 75 -> "1:15"). */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = (rounded % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Bytes -> "1,2 MB" / "340 KB" en español. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = bytes / (1024 * 1024);
  const text = mb >= 10 ? Math.round(mb).toString() : mb.toFixed(1).replace(".", ",");
  return `${text} MB`;
}
