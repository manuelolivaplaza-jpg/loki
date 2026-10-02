/**
 * Literales de UI del chat con Loki IA (sin mocks ni streaming simulado).
 *
 * La respuesta real la genera la Edge Function `loki-chat` de Supabase; aquí
 * solo viven el id estable del chat privado, los textos vacíos, los chips de
 * arranque y el "conectando". Puro (sin React): se importa desde pantallas,
 * componentes y la capa de datos.
 */

/** Id del chat privado con Loki (el mismo id de la ruta `/chat/loki-ia`). */
export const AI_CHAT_ID = "loki-ia";

/**
 * `authorId` de los mensajes `type: "ai"`. No es el uid (así la fila no se
 * alinea a la derecha ni hereda la burbuja del usuario) ni un id "real".
 */
export const AI_AUTHOR_ID = "loki";

/** Estado visible mientras la Edge Function genera la respuesta. */
export const AI_CONNECTING_TEXT = "Conectando con Loki…";

/** Título del chat con el asistente. */
export const AI_CHAT_NAME = "Loki IA";

/** Chips de arranque: se muestran solo cuando el chat está vacío. */
export const AI_SUGGESTIONS: readonly string[] = [
  "¿Qué tengo hoy?",
  "Recuérdame mañana a las 9 sacar la basura",
  "Loki, recuerda que el desayuno del domingo es a las 11",
  "¿Cuál era la clave del wifi?",
];

/** Texto del estado vacío del chat con Loki. */
export const AI_EMPTY_TITLE = "Habla con Loki";
export const AI_EMPTY_DESCRIPTION =
  "Pregunta lo que necesites para empezar.";

/** Placeholder del composer en `/chat/loki-ia`. */
export const AI_PLACEHOLDER = "Escribe a Loki";
