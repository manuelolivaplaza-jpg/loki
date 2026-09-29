/**
 * T18: respuesta a `@loki` / `@ai` dentro de los chats de un espacio.
 *
 * Se dispara con cada mensaje nuevo de
 * `workspaces/{wsId}/chats/{chatId}/messages/{messageId}` y, si el mensaje
 * menciona a la IA, escribe la respuesta con **Admin SDK** en el mismo chat
 * con `type: "ai"`.
 *
 * Por qué Admin SDK y no el cliente: `firestore.rules` solo admite
 * `['user', 'post', 'system']` al crear mensajes de espacio y exige
 * `authorId == request.auth.uid`, así que el cliente no puede escribir la
 * respuesta de la IA. Con Admin SDK la función sí (privilegio de Admin).
 *
 * Con `mentions[]` e ids ya resueltos, este trigger hace la misma labor que
 * el aviso "Loki está desactivada…" del cliente, pero con la respuesta real.
 */

import { logger } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { writeWorkspaceAiMessage } from "./admin";
import {
  AI_SYSTEM_PROMPT,
  AI_SECRETS,
  MAX_PROMPT_CHARS,
  createProvider,
  type AiTurn,
} from "./ai";

// La región se fija UNA vez en `index.ts` (setGlobalOptions): aquí va solo en
// la propia función, que es donde se usa.

/** Ids que cuentan como mención a la IA en `mentions[]`. */
const LOKI_MENTION_IDS = new Set(["loki", "ai"]);

/** Tokens `@Nombre` del texto (admite tildes y eñe). */
const MENTION_TOKEN = /@([\p{L}\p{N}_.-]+)/gu;

/** Rango de marcas diacríticas combinantes (NFD → base). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Sin tildes y en minúsculas, como el parser de menciones de la app. */
function normalize(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

/**
 * ¿El mensaje nombra a la IA? Se mira `mentions[]` (ids ya resueltos por el
 * cliente) y, por si acaso, los tokens `@loki` / `@ai` del texto. No se
 * busca la palabra suelta: responder a cada mensaje que diga "inteligente"
 * sería ruido.
 */
export function mentionsLoki(
  text: string,
  mentions: readonly string[],
): boolean {
  for (const mention of mentions) {
    if (LOKI_MENTION_IDS.has(mention.trim().toLowerCase())) return true;
  }
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const name = normalize(match[1] ?? "");
    if (LOKI_MENTION_IDS.has(name)) return true;
  }
  return false;
}

interface MentionEventData {
  authorId?: unknown;
  text?: unknown;
  mentions?: unknown;
  type?: unknown;
  deleted?: unknown;
}

/**
 * Nota de alcance: el aviso del cliente (`mentionsLoki` en
 * `src/lib/chat/mentions.ts`) también salta con la palabra suelta "loki" o
 * "ai" sin arroba, porque ahí solo se trata de avisar. Este trigger es más
 * estricto a propósito: responder a un mensaje por decir "es una ia
 * inteligente" sería ruido, así que exige `@loki` / `@ai` o el id en
 * `mentions[]`.
 */
function readMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Turnos para el modelo: lo que escribió la persona va como "user" y lo que
 * escribió la IA (authorId "loki", o sea este mismo backend) como
 * "assistant". Ahora mismo solo se pasa el mensaje que disparó el trigger
 * (TODO: ampliar con los últimos mensajes del chat cuando haya contexto).
 */
function toTurns(rows: readonly { authorId: string; text: string }[]): AiTurn[] {
  return rows
    .filter((row) => row.text.trim() !== "")
    .map((row) => ({
      role: row.authorId === "loki" ? ("assistant" as const) : ("user" as const),
      text: row.text.slice(0, MAX_PROMPT_CHARS),
    }));
}

/**
 * Trigger: mensaje creado en un chat de espacio → respuesta de Loki si
 * menciona `@loki` / `@ai`.
 */
export const onMention = onDocumentCreated(
  {
    document: "workspaces/{wsId}/chats/{chatId}/messages/{messageId}",
    region: "europe-west1",
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: AI_SECRETS,
  },
  async (event): Promise<void> => {
    const snapshot = event.data;
    if (snapshot === undefined) return;
    const data = snapshot.data() as MentionEventData;
    const wsId = event.params["wsId"] ?? "";
    const chatId = event.params["chatId"] ?? "";
    if (wsId === "" || chatId === "") return;

    // La respuesta de la IA no vuelve a disparar el trigger: es type "ai" y
    // no menciona a nadie. El borrado suave tampoco.
    if (data.type === "ai" || data.deleted === true) return;
    const text = typeof data.text === "string" ? data.text : "";
    if (text.trim() === "") return;
    if (!mentionsLoki(text, readMentions(data.mentions))) return;

    let provider;
    try {
      provider = createProvider();
    } catch (error) {
      logger.error("onMention: no hay proveedor disponible", {
        wsId,
        chatId,
        error: String(error),
      });
      return;
    }

    try {
      const turns = toTurns([
        { authorId: typeof data.authorId === "string" ? data.authorId : "", text },
      ]);
      const reply = await provider.generate(turns, AI_SYSTEM_PROMPT);
      const messageId = await writeWorkspaceAiMessage(wsId, chatId, reply);
      logger.info("onMention: respuesta escrita", {
        wsId,
        chatId,
        messageId,
        provider: provider.id,
        model: provider.model,
      });
    } catch (error) {
      // Un fallo aquí no debe reintentar en bucle: se registra y se corta.
      logger.error("onMention: el proveedor falló", {
        wsId,
        chatId,
        error: String(error),
      });
    }
  },
);
