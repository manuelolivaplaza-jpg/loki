/**
 * Publicaciones (T17): feed estilo X unido al chat.
 *
 * Las publicaciones no son una colección nueva: son mensajes `type: "post"`
 * con `threadParentId: null` dentro del chat `posts` del espacio (el mismo
 * batch que crea `general`). Los comentarios son respuestas de hilo
 * normales (`type: "user"` con `threadParentId`).
 *
 * Este archivo es puro (sin React ni firebase) para poder testearlo o
 * importarlo desde cualquier capa.
 */

import { toDateSafe, type MessageDateInput } from "@/lib/chat/format";
import type { MessageDoc } from "@/types/chat";

/** Id del chat que guarda las publicaciones del espacio. */
export const POSTS_CHAT_ID = "posts";
/** Nombre y emoji del doc chats/posts (los mismos en toda la app). */
export const POSTS_CHAT_NAME = "Publicaciones";
export const POSTS_CHAT_EMOJI = "\u{1F4F0}";

/** Placeholder del composer de publicaciones. */
export const POSTS_PLACEHOLDER = "¿Qué quieres compartir?";
/** Botón de publicación (deshabilitado mientras el texto esté vacío). */
export const POSTS_PUBLISH_LABEL = "Publicar";
/** Aviso del botón de imagen, deshabilitado hasta que existan subidas. */
export const POSTS_MEDIA_LABEL = "Adjuntar imagen";
export const POSTS_MEDIA_SOON = "Próximamente";
/** Estado vacío amable del feed. */
export const POSTS_EMPTY_TITLE = "Sin publicaciones";
export const POSTS_EMPTY_DESCRIPTION =
  "Todavía no hay publicaciones. Comparte algo con tu espacio.";
/** Título del ThreadPanel cuando el hilo de un post son sus comentarios. */
export const POSTS_COMMENTS_TITLE = "Comentarios";
export const POSTS_COMMENTS_PARENT_LABEL = "Publicación";

/** Corazón rojo (U+2764 U+FE0F): único emoji del "Me gusta" de un post. */
export const POST_LIKE_EMOJI = String.fromCodePoint(0x2764, 0xfe0f);

/** P posts vivos en el feed (mismo tope que el timeline del chat). */
export const POSTS_PAGE_SIZE = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Tiempo relativo del post: "ahora" | "5 min" | "2 h" | "ayer" | fecha.
 * Mismo idioma que el resto de la app (sin tildes en los literales).
 */
export function formatPostTime(
  input: MessageDateInput,
  now = new Date(),
): string {
  const date = toDateSafe(input) ?? now;
  const diff = now.getTime() - date.getTime();
  if (diff < MINUTE_MS) return "ahora";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min`;
  if (isSameDay(date, now)) return `${Math.floor(diff / HOUR_MS)} h`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return "ayer";
  const diffDays = Math.floor((dayStart(now) - dayStart(date)) / 86_400_000);
  if (diffDays > 0 && diffDays < 7) {
    return new Intl.DateTimeFormat("es-ES", { weekday: "short" })
      .format(date)
      .replace(".", "");
  }
  const day = date.getDate().toString().padStart(2, "0");
  if (date.getFullYear() === now.getFullYear()) {
    const month = new Intl.DateTimeFormat("es-ES", { month: "short" }).format(date);
    return `${date.getDate()} ${month}`;
  }
  const monthNumber = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${day}/${monthNumber}/${date.getFullYear().toString().slice(2)}`;
}

/** Un post es un mensaje `type: "post"` del timeline (sin padre de hilo). */
export function isPostMessage(message: MessageDoc): boolean {
  return message.type === "post" && message.threadParentId === null;
}

/** Uids que dejaron el corazón en un post (nunca undefined). */
export function postLikeUids(message: MessageDoc): string[] {
  const uids = message.reactions?.[POST_LIKE_EMOJI];
  return Array.isArray(uids) ? uids : [];
}

/** Total de "Me gusta" de un post. */
export function postLikeCount(message: MessageDoc): number {
  return postLikeUids(message).length;
}

/** Ya di "Me gusta" a este post (solo se alterna el uid propio). */
export function hasPostLike(message: MessageDoc, uid: string | null): boolean {
  if (uid === null) return false;
  return postLikeUids(message).includes(uid);
}

/** Número de comentarios (respuestas de hilo) de un post. */
export function postCommentCount(message: MessageDoc): number {
  return message.threadCount ?? 0;
}
