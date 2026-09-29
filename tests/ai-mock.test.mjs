/**
 * T18: unitario ligero de la parte pura de Loki IA (`ai-mock.ts`).
 * Sin runner (ni node --test ni vitest) y sin firebase: solo node:assert.
 * Uso: `node tests/ai-mock.test.mjs` (o `npm run test:ai-mock`).
 */
import assert from "node:assert/strict";

import {
  AI_AUTHOR_ID,
  AI_CHAT_ID,
  AI_CHAT_NAME,
  AI_CONNECTING_TEXT,
  AI_EMPTY_DESCRIPTION,
  AI_EMPTY_TITLE,
  AI_MOCK_PREFIX,
  AI_PLACEHOLDER,
  AI_STREAM_INTERVAL_MS,
  AI_SUGGESTIONS,
  buildMockAiReply,
  streamChunks,
} from "../src/lib/chat/ai-mock.ts";
import { LOKI_DISABLED_TEXT } from "../src/lib/chat/mentions.ts";

let checks = 0;
function ok(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
function deep(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

// --- Identidad del chat ------------------------------------------------------
equal(AI_CHAT_ID, "loki-ia", "el id del chat con Loki es el de la ruta");
equal(AI_CHAT_NAME, "Loki IA", "nombre visible del chat");
equal(AI_AUTHOR_ID, "loki", "authorId de los mensajes type 'ai'");

// --- Textos de UI con tildes y signos correctos -----------------------------
deep(
  AI_SUGGESTIONS,
  ["¿Qué tengo hoy?", "Resume mi semana", "Crea un recordatorio"],
  "los tres chips de arranque, exactos",
);
equal(AI_CONNECTING_TEXT, "Conectando con Loki…", "estado de espera de la callable");
equal(AI_PLACEHOLDER, "Escribe a Loki", "placeholder del composer");
equal(AI_EMPTY_TITLE, "Habla con Loki", "título del estado vacío");
equal(
  AI_EMPTY_DESCRIPTION,
  "Pregunta lo que necesites para empezar.",
  "descripción del estado vacío",
);
equal(
  LOKI_DISABLED_TEXT,
  "Loki está desactivada. Actívala en Configuración → Loki IA.",
  "texto exacto del aviso de IA desactivada",
);

// --- Respuesta MOCK ----------------------------------------------------------
equal(AI_MOCK_PREFIX, "[Simulado] ", "prefijo que marca la respuesta como simulada");

const CASES = [
  ["¿Qué tengo hoy?", /calendario|tareas/i],
  ["Resume mi semana", /notas|chats|resumen/i],
  ["Crea un recordatorio", /recordatorio/i],
  ["Ágenda de mañana", /calendario|tareas/i],
  ["quiero un resumen", /notas|chats|resumen/i],
  ["ponme un aviso a las 7", /recordatorio/i],
];
for (const [prompt, expected] of CASES) {
  const reply = buildMockAiReply(prompt);
  ok(reply.startsWith(AI_MOCK_PREFIX), `la respuesta a "${prompt}" lleva el prefijo`);
  ok(expected.test(reply), `la respuesta a "${prompt}" es contextual (${expected})`);
  ok(!/tienes \d+ (tareas|eventos)/i.test(reply), `la respuesta a "${prompt}" no inventa datos`);
}

{
  const generic = buildMockAiReply("hola");
  ok(generic.startsWith(AI_MOCK_PREFIX), "el texto neutro también va marcado");
  ok(
    /no hay una IA detr/i.test(generic),
    "el texto neutro aclara que no hay un modelo detrás",
  );
  equal(
    buildMockAiReply("¿Qué tengo hoy?"),
    buildMockAiReply("¿que tengo hoy?"),
    "el mock no depende de tildes ni mayúsculas",
  );
  equal(
    buildMockAiReply(""),
    buildMockAiReply(""),
    "un prompt vacío no rompe (cae en la respuesta genérica)",
  );
}

// --- Streaming ---------------------------------------------------------------
equal(AI_STREAM_INTERVAL_MS, 30, "una parte cada 30 ms");
deep(streamChunks(""), [], "texto vacío sin partes");
{
  const text = buildMockAiReply("¿Qué tengo hoy?");
  const chunks = streamChunks(text);
  ok(chunks.length > 1, "el texto se parte en varias palabras");
  equal(chunks.join(""), text, "las partes rearman el texto original");
  ok(
    chunks.every((chunk) => chunk.trim() === "" || !chunk.includes("  ")),
    "los espacios van en partes propias (no se duplican ni se pierden)",
  );
  ok(
    chunks[0] === AI_MOCK_PREFIX.trim() || text.startsWith(chunks[0]),
    "la primera parte es el principio del texto",
  );
}

console.log(`ai-mock.test.mjs: ${checks} checks OK`);
