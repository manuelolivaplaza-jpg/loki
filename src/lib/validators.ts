/**
 * Validadores manuales estrictos (T35).
 *
 * Sin dependencias nuevas (no hay zod en `package.json`): tipos +
 * longitudes, equivalentes en cliente y Edge Functions. El cliente los usa
 * antes de enviar (mensajes, publicaciones, eventos, tareas); las Edge
 * Functions aplican los mismos límites al recibir.
 */

export const LIMITS = {
  /** Mensaje de chat / publicación / comentario. */
  messageText: { min: 1, max: 4000 },
  /** Título de evento / proyecto / tarea. */
  title: { min: 1, max: 120 },
  /** Título largo de tarea (la Edge acepta hasta 200). */
  taskTitle: { min: 1, max: 200 },
  /** Notas / descripción / detalle. */
  notes: { min: 0, max: 2000 },
  /** Nombre de espacio / perfil. */
  name: { min: 2, max: 40 },
  /** Código de invitación (8, sin 0/O/1/I). */
  inviteCode: { length: 8 },
  /** Ids opacos (uuid / claves de chat). */
  id: { min: 1, max: 200 },
  /** Consulta de búsqueda. */
  query: { min: 2, max: 80 },
} as const;

const INVITE_CODE_RE = /^[A-Z2-9]{8}$/;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Texto de mensaje/publicación (1–4000 tras recortar). */
export function validMessageText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text === "") return null;
  if (text.length > LIMITS.messageText.max) return null;
  return text;
}

/** Título corto (evento/proyecto, 1–120 tras recortar). */
export function validTitle(value: unknown, max = LIMITS.title.max): string | null {
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text === "") return null;
  if (text.length > max) return null;
  return text;
}

/** Nombre (espacio/perfil, 2–40 tras recortar). */
export function validName(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text.length < LIMITS.name.min) return null;
  if (text.length > LIMITS.name.max) return null;
  return text;
}

/** Código de invitación (8 mayúsculas sin 0/O/1/I). */
export function validInviteCode(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : null;
  if (text === null) return null;
  return INVITE_CODE_RE.test(text) ? text : null;
}

/** Id opaco no vacío de hasta 200 caracteres. */
export function validId(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length <= LIMITS.id.max ? value : null;
}

/** Consulta de búsqueda (2–80 tras recortar, sin comodines). */
export function validQuery(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text.length < LIMITS.query.min) return null;
  if (text.length > LIMITS.query.max) return null;
  return text.replace(/[%*]/g, "").slice(0, LIMITS.query.max);
}

/** Fecha ISO válida (o null si no es fecha). */
export function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export { clean };
