/**
 * Guardia de rutas: nada sale de las carpetas permitidas.
 *
 * Se aplica a `find_files`, `send_file` y a los scripts registrados:
 * - Rechaza `..`, rutas UNC (`\\servidor`, `//servidor`) y absolutas que
 *   escapen de la base local.
 * - Resuelve enlaces simbólicos con `realpath` y vuelve a comprobar que el
 *   destino real sigue dentro de la base o de la carpeta permitida.
 */

import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export function isUncPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

function insideDir(candidate: string, dir: string): boolean {
  const rel = relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rejectReason(p: string): string {
  return `Esa ruta no está permitida: ${p.slice(0, 120)}.`;
}

/**
 * Resuelve `wanted` (relativa o nombre) contra `base` y exige que quede
 * dentro de `base` (o de `scopeDir` si se da, que a su vez debe estar dentro
 * de `base`). Devuelve la ruta absoluta o lanza un Error en español.
 */
export async function resolveInsideBase(
  base: string,
  wanted: string,
  scopeDir?: string,
): Promise<string> {
  const text = wanted.trim();
  if (text === "") throw new Error("Falta la ruta.");
  if (text.includes("..")) throw new Error(rejectReason(text));
  if (isUncPath(text)) throw new Error(rejectReason(text));
  const absoluteBase = resolve(base);
  const scopeAbs = scopeDir === undefined ? absoluteBase : resolve(absoluteBase, scopeDir);
  if (!insideDir(scopeAbs, absoluteBase)) throw new Error(rejectReason(scopeDir ?? ""));
  let candidate: string;
  if (isAbsolute(text)) {
    candidate = normalize(text);
  } else {
    candidate = join(scopeAbs, text);
  }
  if (!insideDir(candidate, absoluteBase)) throw new Error(rejectReason(text));
  // Enlaces simbólicos: el destino real también debe quedar dentro.
  try {
    const real = await realpath(candidate);
    if (!insideDir(real, absoluteBase)) throw new Error(rejectReason(text));
    return real;
  } catch (error) {
    // Si no existe, igual se devuelve la ruta contenida (find_files la ignora,
    // send_file falla con "no existe" en vez de "no permitida").
    if (error instanceof Error && error.message.startsWith("Esa ruta no está permitida")) {
      throw error;
    }
    return candidate;
  }
}

/** ¿Este `dir` pedido (nombre relativo) está en la lista permitida? */
export function dirAllowed(requested: string, allowed: string[]): boolean {
  const clean = requested.trim().replace(/^[/\\]+|[/\\]+$/g, "");
  if (clean === "" || clean.includes("..") || isUncPath(clean)) return false;
  const parts = clean.split(sep);
  const top = parts[0] ?? "";
  return allowed.some((a) => a === top || a === clean);
}

/** Nombres de scripts: cortos, sin rutas ni comandos. */
export function isScriptNameSafe(name: string): boolean {
  return /^[A-Za-z0-9 _áéíóúñüÁÉÍÓÚÑÜ-]{1,60}$/.test(name.trim());
}
