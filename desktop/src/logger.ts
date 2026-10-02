/**
 * Log local rotativo: cada comando ejecutado queda anotado en el PC.
 *
 * `logs/actividad-AAAA-MM-DD.log`, una línea por evento. Rota por tamaño
 * (1 MB por archivo, hasta 5) y por día. Nunca sale del PC ni gasta tokens:
 * es texto local para "qué hizo Loki en mi PC".
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 5;

function logsDir(): string {
  return join(dataDir(), "logs");
}

function todayFile(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return join(logsDir(), `actividad-${y}-${m}-${d}.log`);
}

function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;
  try {
    for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        renameSync(from, to);
      } catch {
        // Si no existe ese tramo, se sigue con el siguiente.
      }
    }
  } catch {
    // Rotar nunca rompe la ejecución.
  }
}

export function logLocal(line: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    const file = todayFile();
    rotateIfNeeded(file);
    const stamp = new Date().toISOString();
    writeFileSync(file, `${stamp} ${line}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    // El log nunca rompe la ejecución.
  }
}

export function readRecentLog(maxLines = 30): string[] {
  try {
    const files = readdirSync(logsDir())
      .filter((f) => f.startsWith("actividad-") && f.endsWith(".log"))
      .sort()
      .reverse();
    const out: string[] = [];
    for (const f of files) {
      const raw = readFileSync(join(logsDir(), f), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
        const line = lines[i];
        if (line !== undefined) out.push(line);
      }
      if (out.length >= maxLines) break;
    }
    return out;
  } catch {
    return [];
  }
}
