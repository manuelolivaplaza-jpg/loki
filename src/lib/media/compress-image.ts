/**
 * Compresión de imágenes en el cliente (sin dependencias).
 *
 * Reescala con canvas al reescalar el lado mayor a 2048px como máximo y
 * exporta a WebP (calidad 0.82). Si el original ya es pequeño, es SVG o es
 * GIF (para no romper animaciones), se devuelve tal cual.
 */

const MAX_SIDE = 2048;
const WEBP_QUALITY = 0.82;
/** Por debajo de esto no compensa recomprimir: se deja el original. */
const SMALL_ENOUGH_BYTES = 800 * 1024;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void =>
      reject(new Error("No se pudo leer la imagen."));
    img.src = url;
  });
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/webp",
      WEBP_QUALITY,
    );
  });
}

/**
 * Devuelve un `File` listo para subir. Ante cualquier fallo (canvas no
 * disponible, imagen corrupta…) devuelve el original: nunca bloquea el envío.
 */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // SVG y GIF se dejan intactos (vectorial y animaciones).
  if (file.type === "image/svg+xml" || file.type === "image/gif") {
    return file;
  }
  if (file.size <= SMALL_ENOUGH_BYTES) return file;
  if (typeof document === "undefined") return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) return file;

    const scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    // Sin reescalado y ya en WebP: no hay nada que ganar.
    if (scale >= 1 && file.type === "image/webp") return file;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return file;
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await canvasToWebp(canvas);
    if (blob === null || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "imagen";
    return new File([blob], `${base}.webp`, { type: "image/webp" });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
