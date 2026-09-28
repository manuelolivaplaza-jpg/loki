/**
 * Avatares deterministas (T16).
 *
 * El color de una persona (o de un chat) sale de un hash estable de su
 * id, así que es siempre el mismo en la burbuja, el hilo, el menú de
 * menciones y el panel de miembros sin guardar nada en Firestore ni
 * calcularlo en cada pantalla.
 *
 * Este archivo es puro (sin React ni firebase) para poder testearlo o
 * importarlo desde cualquier capa.
 */

/** Paleta sobria de 8 colores (ninguno satura la burbuja ni compite con `accent`). */
export const AVATAR_COLOR_PALETTE: readonly string[] = [
  "#5B8DEF", // azul acero
  "#E07A5F", // terracota
  "#3D9970", // verde
  "#9B72CF", // violeta
  "#D4A017", // ocre
  "#2A9D8F", // verde azulado
  "#C2185B", // guinda
  "#6C757D", // gris
];

/** Gris de la paleta: reserva cuando no hay id (o el id está vacío). */
export const AVATAR_COLOR_FALLBACK = "#6C757D";

/**
 * Hash estable (djb2 truncado a 32 bits sin signo): el mismo id da
 * siempre el mismo número en cualquier plataforma.
 */
export function hashId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Color determinista de un id (uid de persona, id de chat, etc.).
 * Sin id devuelve el gris de la paleta.
 */
export function avatarColorFor(id: string | null | undefined): string {
  const value = (id ?? "").trim();
  if (value === "") return AVATAR_COLOR_FALLBACK;
  return AVATAR_COLOR_PALETTE[hashId(value) % AVATAR_COLOR_PALETTE.length] ?? AVATAR_COLOR_FALLBACK;
}
