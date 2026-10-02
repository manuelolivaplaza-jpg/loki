/**
 * Validador puro del handle de un agente (@handle).
 *
 * La misma regla vive en tres lados con el mismo criterio: aquí (feedback
 * inmediato en el formulario), la Edge `agent-connections` y la función
 * `validate_agent_handle` (choques con miembros y otros agentes del
 * espacio). Sin dependencias: se puede probar con Node directo.
 */

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

const RESERVED: ReadonlySet<string> = new Set([
  "loki",
  "loki-ia",
  "lokia",
  "admin",
  "sistema",
  "system",
]);

/** Quita @ y pasa a minúsculas. Null si no es texto. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * ¿El handle tiene forma válida y no es reservado? (Los choques con miembros
 * y otros agentes los revisa el servidor, porque necesitan la base.)
 */
export function isHandleShapeOk(raw: string): boolean {
  const clean = normalizeHandle(raw);
  if (!HANDLE_RE.test(clean)) return false;
  if (RESERVED.has(clean)) return false;
  return true;
}

/** Motivo en español (o null si está bien de forma). */
export function handleShapeError(raw: string): string | null {
  const clean = normalizeHandle(raw);
  if (clean === "") return "Ponle un handle para mencionarlo (p. ej. mi-bot).";
  if (RESERVED.has(clean)) {
    return "Ese handle es reservado (es de Loki). Prueba con otro.";
  }
  if (!HANDLE_RE.test(clean)) {
    return "Solo minúsculas, números, punto, guion o subrayado (2 a 31 caracteres).";
  }
  return null;
}
