/**
 * Scripts registrados: el usuario agrega en la app de escritorio scripts con
 * nombre (ruta fija) que después invoca desde Loki por su nombre.
 *
 * Loki NUNCA envía el contenido de un script: `run_script` trae solo
 * `{text: "<nombre>"}`, y aquí se resuelve a la ruta fija registrada.
 * Registrar exige que el archivo exista, esté dentro de la base local y tenga
 * una extensión permitida (.ps1/.cmd/.bat en Windows, .sh en Unix).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { join } from "node:path";
import { dataDir } from "./config.js";
import { isScriptNameSafe, resolveInsideBase } from "./path-guard.js";

export interface RegisteredScript {
  name: string;
  path: string;
  addedAt: string;
}

const ALLOWED_EXTS =
  process.platform === "win32" ? [".ps1", ".cmd", ".bat"] : [".sh"];

function scriptsPath(): string {
  return join(dataDir(), "scripts.json");
}

function readAll(): RegisteredScript[] {
  try {
    const raw = readFileSync(scriptsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RegisteredScript[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec["name"] !== "string" || typeof rec["path"] !== "string") continue;
      if (typeof rec["addedAt"] !== "string") continue;
      out.push({ name: rec["name"], path: rec["path"], addedAt: rec["addedAt"] });
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(scripts: RegisteredScript[]): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(scriptsPath(), JSON.stringify(scripts, null, 2) + "\n", "utf8");
}

export function listScripts(): RegisteredScript[] {
  return readAll();
}

export function findScript(name: string): RegisteredScript | null {
  const clean = name.trim().toLowerCase();
  for (const s of readAll()) {
    if (s.name.toLowerCase() === clean) return s;
  }
  return null;
}

/** Registra `ruta` con `nombre`. La ruta queda fija: Loki solo manda el nombre. */
export async function addScript(name: string, filePath: string, baseDir: string): Promise<RegisteredScript> {
  const clean = name.trim();
  if (!isScriptNameSafe(clean)) {
    throw new Error("El nombre del script solo lleva letras, números, espacios y guiones (máx 60).");
  }
  if (findScript(clean) !== null) {
    throw new Error("Ya hay un script con ese nombre. Bórralo primero si quieres cambiarlo.");
  }
  const abs = await resolveInsideBase(baseDir, filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error("Ese archivo no existe en este PC.");
  }
  const ext = extname(abs).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) {
    throw new Error(`Solo scripts ${ALLOWED_EXTS.join(", ")} (nada de ejecutables sueltos).`);
  }
  const entry: RegisteredScript = {
    name: clean,
    path: resolve(abs),
    addedAt: new Date().toISOString(),
  };
  writeAll([...readAll(), entry]);
  return entry;
}

export function removeScript(name: string): boolean {
  const clean = name.trim().toLowerCase();
  const kept = readAll().filter((s) => s.name.toLowerCase() !== clean);
  if (kept.length === readAll().length) return false;
  writeAll(kept);
  return true;
}
