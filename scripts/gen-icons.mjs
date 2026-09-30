/**
 * Genera los PNG de la PWA desde cero, sin dependencias nuevas.
 *
 * Solo usa node (fs + zlib): escribe PNG RGBA válidos con un encoder mínimo
 * (IHDR + IDAT deflate + IEND con CRC32 propio). La "L" de Loki se dibuja
 * por rectángulos en el propio buffer, así no hace falta canvas ni
 * herramientas del sistema.
 *
 * Salida en `public/icons/`:
 *   - icon-192.png / icon-512.png (purpose "any", fondo claro)
 *   - maskable-192.png / maskable-512.png (fondo oscuro a sangre, "L" al
 *     66 % central para la zona segura de maskable)
 *   - apple-touch-icon.png (180, fondo claro)
 *
 * Uso: `npm run icons` (o `node scripts/gen-icons.mjs`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "icons");

const DARK = [15, 20, 25, 255];
const LIGHT = [255, 255, 255, 255];
const ACCENT = [0, 180, 216, 255];

/** Tabla CRC32 (IEEE) para los chunks del PNG. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c % 2 === 0 ? c >>> 1 : 0xedb88320 ^ (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Codifica un buffer RGBA (size x size) a PNG. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filtro "none"
    rgba
      .subarray(y * size * 4, (y + 1) * size * 4)
      .forEach((value, i) => {
        raw[rowStart + 1 + i] = value;
      });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fill(rgba, size, color) {
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = color[3];
  }
}

function fillRect(rgba, size, x0, y0, w, h, color) {
  const xa = Math.max(0, Math.round(x0));
  const ya = Math.max(0, Math.round(y0));
  const xb = Math.min(size, Math.round(x0 + w));
  const yb = Math.min(size, Math.round(y0 + h));
  for (let y = ya; y < yb; y += 1) {
    for (let x = xa; x < xb; x += 1) {
      const i = (y * size + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
}

function fillCircle(rgba, size, cx, cy, r, color) {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(size - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y += 1) {
    for (let x = xa; x <= xb; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * size + x) * 4;
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = color[3];
      }
    }
  }
}

/**
 * Dibuja la "L" de Loki centrada.
 * `scale` 1 = ocupa el 55 % del lienzo ("any"); 0.66 = zona segura maskable.
 */
function drawL(rgba, size, fg, scale) {
  const bar = size * 0.11 * scale;
  const lWidth = size * 0.42 * scale;
  const lHeight = size * 0.55 * scale;
  const cx = size / 2;
  const cy = size / 2 - size * 0.02 * scale;
  const left = cx - lWidth / 2;
  const top = cy - lHeight / 2;
  // Palo vertical + base horizontal.
  fillRect(rgba, size, left, top, bar, lHeight, fg);
  fillRect(rgba, size, left, top + lHeight - bar, lWidth, bar, fg);
  // Punto accent abajo a la derecha.
  fillCircle(
    rgba,
    size,
    left + lWidth + bar * 0.7,
    top + lHeight - bar / 2,
    bar * 0.52,
    ACCENT,
  );
}

function makeIcon(size, { background, foreground, maskable }) {
  const rgba = new Uint8Array(size * size * 4);
  fill(rgba, size, background);
  drawL(rgba, size, foreground, maskable ? 0.66 : 1);
  return encodePng(size, rgba);
}

mkdirSync(outDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, background: LIGHT, foreground: DARK, maskable: false },
  { file: "icon-512.png", size: 512, background: LIGHT, foreground: DARK, maskable: false },
  { file: "maskable-192.png", size: 192, background: DARK, foreground: LIGHT, maskable: true },
  { file: "maskable-512.png", size: 512, background: DARK, foreground: LIGHT, maskable: true },
  { file: "apple-touch-icon.png", size: 180, background: LIGHT, foreground: DARK, maskable: false },
];

for (const target of targets) {
  const png = makeIcon(target.size, target);
  writeFileSync(join(outDir, target.file), png);
  console.log(`icons: ${target.file} (${target.size}x${target.size})`);
}
