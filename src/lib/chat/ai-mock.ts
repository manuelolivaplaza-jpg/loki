/**
 * T18: Loki IA — parte pura (sin React, sin firebase) de la conversación
 * con el asistente.
 *
 * Enquanto `NEXT_PUBLIC_AI_ENABLED !== "true"` (fase 1-2, el flag por
 * defecto) NO hay modelo detrás: la app escribe una respuesta MOCK en
 * `users/{uid}/aiChats/{chatId}/messages` con type "ai" (las reglas ya lo
 * permiten al propio usuario) y la UI la revela palabra a palabra. Con el
 * flag en "true" la UI se queda en "Conectando con Loki…" esperando a la
 * callable `aiChat` de `functions/` y no inventa nada.
 *
 * Este archivo no debe importar nada de firebase ni de React: así los
 * literales de UI viven en un solo sitio y se pueden testear con Node.
 */

/** Rango de marcas diacríticas combinantes (NFD → base). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Minúsculas sin tildes, para que "Ágenda" y "Resume" caigan en la misma
 * regla que "agenda" y "resumen". Igual que `normalizeMention` de
 * `mentions.ts`, replicado aquí para que este archivo no dependa de nada
 * (se importa directo con Node en los tests, sin alias ni extensiones).
 */
function normalize(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

/** Prefijo obligatorio de toda respuesta simulada (la marca de mock). */
export const AI_MOCK_PREFIX = "[Simulado] ";

/** Id del chat privado con Loki (el mismo id de la ruta `/chat/loki-ia`). */
export const AI_CHAT_ID = "loki-ia";

/**
 * `authorId` de los mensajes `type: "ai"` del chat privado. No es el uid
 * (así la fila no se alinea a la derecha ni hereda la burbuja del usuario)
 * ni un id "real" de la IA.
 */
export const AI_AUTHOR_ID = "loki";

/** Estado visible mientras se espera a la callable `aiChat`. */
export const AI_CONNECTING_TEXT = "Conectando con Loki…";

/** Título del chat con el asistente. */
export const AI_CHAT_NAME = "Loki IA";

/** Chips de arranque: se muestran solo cuando el chat está vacío. */
export const AI_SUGGESTIONS: readonly string[] = [
  "¿Qué tengo hoy?",
  "Resume mi semana",
  "Crea un recordatorio",
];

/** Texto del estado vacío del chat con Loki. */
export const AI_EMPTY_TITLE = "Habla con Loki";
export const AI_EMPTY_DESCRIPTION =
  "Pregunta lo que necesites para empezar.";

/** Placeholder del composer en `/chat/loki-ia`. */
export const AI_PLACEHOLDER = "Escribe a Loki";

/** Milisegundos entre palabra y palabra al revelar la respuesta. */
export const AI_STREAM_INTERVAL_MS = 30;

/**
 * Partes del texto para el streaming: palabras y espacios por separado, de
 * forma que concatenarlas reconstruye el texto original byte a byte
 * (los espacios no se pierden entre dos palabras).
 */
export function streamChunks(text: string): string[] {
  if (text === "") return [];
  return text.split(/(\s+)/).filter((chunk) => chunk !== "");
}

interface MockRule {
  match: RegExp;
  body: string;
}

/**
 * Respuestas simuladas. Son genéricas y contextuales, pero NUNCA inventan
 * datos: no hay calendario, ni tareas ni notas detrás, así que el mock lo
 * dice en vez de rellenar con ciudades.
 */
const MOCK_RULES: readonly MockRule[] = [
  {
    match: /\b(recordatorio|recordatorios|recuerda|recordar|aviso|avisos|alarma)\b/,
    body:
      "Entendí que quieres un recordatorio. Todavía no puedo crearlo ni " +
      "guardarlo, y no quiero inventarte la hora: dime cuándo y lo dejamos " +
      "anotado cuando Loki esté activada.",
  },
  {
    match: /\b(hoy|agenda|calendario|jornada|reunion|reuniones|tarea|tareas)\b/,
    body:
      "Ahora mismo no leo tu calendario ni tus tareas, así que no te voy a " +
      "inventar la agenda de hoy. Con Loki activada te la resumo con tus " +
      "datos reales.",
  },
  {
    match: /\b(semana|semanal|resumen|resumeme|resumir|resumo)\b/,
    body:
      "No tengo acceso a las notas ni a los chats de esta semana, así que " +
      "el resumen tendría que inventarlo. Cuando Loki esté activada te la " +
      "resumo con lo que hay de verdad en tus espacios.",
  },
];

/** Respuesta simulada para lo que no encaja en ninguna regla. */
const MOCK_DEFAULT_BODY =
  "Recibí tu mensaje, pero todavía no hay una IA detrás: esta respuesta la " +
  "genera la app para que veas cómo se ve la conversación. Activa Loki en " +
  "Configuración para hablar con un modelo de verdad.";

/**
 * Respuesta MOCK para un prompt, con el prefijo `[Simulado] `.
 * Determinista y sin datos inventados (ver `MOCK_RULES`).
 */
export function buildMockAiReply(prompt: string): string {
  // `normalize` quita tildes y baja a minúsculas: así "Resumen" o "Ágenda"
  // caen en la misma regla que "resumen" o "agenda".
  const normalized = normalize(prompt);
  const rule = MOCK_RULES.find((item) => item.match.test(normalized));
  return `${AI_MOCK_PREFIX}${rule?.body ?? MOCK_DEFAULT_BODY}`;
}
