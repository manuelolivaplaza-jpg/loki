/**
 * T18: backend de Loki IA (Cloud Functions, gen 2).
 *
 * ⚠️ FASE 1-2: esto COMPILA pero NO SE DESPLIEGA. El proyecto sigue en el
 * plan gratuito y la IA está apagada por diseño: la app responde con el
 * streaming simulado mientras `NEXT_PUBLIC_AI_ENABLED !== "true"`, y con
 * el flag en "true" se queda en "Conectando con Loki…" sin inventar nada.
 * El despliegue está bloqueado a propósito (`functions/scripts/no-deploy.cjs`,
 * enganchado a `predeploy` en `firebase.json` y a `npm run deploy`).
 *
 * Exporta:
 * - `aiChat` (callable): la conversación privada de `users/{uid}/aiChats`.
 * - `onMention` (trigger): responde a `@loki` / `@ai` en los chats de espacio.
 * - `smartReminders` (programada, cada hora): stub de los avisos inteligente.
 *
 * Los mensajes `type: "ai"` los escribe SIEMPRE este backend con Admin SDK
 * (`./admin`): las reglas (`firestore.rules`) prohíben al cliente escribir
 * `type: "ai"` en los chats de espacio.
 */

import { logger, setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  AI_SYSTEM_PROMPT,
  AI_SECRETS,
  MAX_PROMPT_CHARS,
  createProvider,
  trimHistory,
  type AiTurn,
} from "./ai";
import { safeId, writeAiMessage } from "./admin";

/**
 * Región de todas las funciones. Tiene que ser la misma que la del proyecto;
 * si cambia, ajústala aquí (y en la app, que llama por callable).
 *
 * `setGlobalOptions` se llama UNA sola vez y desde este módulo (el punto de
 * entrada): el SDK avisa si se invoca más de una vez, así que los otros
 * archivos declaran su región en la propia función y nada más.
 */
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

/** Id por defecto del chat privado con Loki (el mismo que la ruta `/chat/loki-ia`). */
const DEFAULT_AI_CHAT_ID = "loki-ia";

/** Tope de mensajes que devuelve la callable (el cliente no los necesita). */
const MAX_HISTORY = 20;

/** Lo que espera `aiChat`. El cliente lo manda (ver TODO en la app). */
export interface AiChatRequest {
  /** Texto del nuevo mensaje del usuario. */
  text?: unknown;
  /** Id del chat privado; por defecto `loki-ia`. */
  chatId?: unknown;
  /** Historial previo `{role, text}`; el backend lo recorta. */
  history?: unknown;
}

export interface AiChatResponse {
  /** Id del mensaje `type: "ai"` escrito por el backend. */
  messageId: string;
  chatId: string;
  /** Texto de la respuesta (la app lo muestra mientras llega por `onSnapshot`). */
  text: string;
  /** Proveedor y modelo usados, solo para diagnóstico en la UI. */
  provider: string;
  model: string;
}

/** Valida el historial que manda el cliente y se queda con los turnos útiles. */
function readHistory(value: unknown): AiTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: AiTurn[] = [];
  for (const item of value.slice(-MAX_HISTORY)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { role?: unknown; text?: unknown };
    if (typeof record.text !== "string" || record.text.trim() === "") continue;
    turns.push({
      role: record.role === "assistant" ? "assistant" : "user",
      text: record.text.slice(0, MAX_PROMPT_CHARS),
    });
  }
  return turns;
}

/**
 * `aiChat`: genera la respuesta de Loki para el chat privado del usuario y
 * la escribe con Admin SDK en `users/{uid}/aiChats/{chatId}/messages` con
 * `type: "ai"`. La app la escucha con `onSnapshot`
 * (`useAiMessages` → `listenAiMessages`), así que el cliente no escribe el
 * mensaje de la IA en los chats de espacio ni necesita permisos de Admin.
 */
export const aiChat = onCall<AiChatRequest, Promise<AiChatResponse>>(
  {
    region: "europe-west1",
    // La app (web y Capacitor) llama con el SDK de Firebase, que ya envía
    // los orígenes permitidos; `cors: true` por si algún día hay otro cliente.
    cors: true,
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: AI_SECRETS,
  },
  async (request): Promise<AiChatResponse> => {
    // 1) Auth: sin sesión no hay uid y no hay dónde escribir.
    const uid = request.auth?.uid ?? "";
    if (uid === "") {
      throw new HttpsError(
        "unauthenticated",
        "Inicia sesión para usar Loki IA.",
      );
    }

    // 2) Entrada: texto no vacío y con tamaño razonable.
    const rawText =
      typeof request.data?.text === "string" ? request.data.text.trim() : "";
    if (rawText === "") {
      throw new HttpsError("invalid-argument", "Escribe un mensaje primero.");
    }
    if (rawText.length > MAX_PROMPT_CHARS) {
      throw new HttpsError(
        "invalid-argument",
        "El mensaje no puede superar los 4000 caracteres.",
      );
    }
    const chatId = safeId(
      typeof request.data?.chatId === "string" ? request.data.chatId : "",
      DEFAULT_AI_CHAT_ID,
    );

    // 3) Modelo: elige Gemini o Claude según AI_PROVIDER.
    let provider;
    try {
      provider = createProvider();
    } catch (error) {
      logger.error("aiChat: no hay proveedor disponible", error);
      throw new HttpsError(
        "failed-precondition",
        "Loki IA no está configurada en el servidor.",
      );
    }

    // 4) Prompt: historial del cliente + este mensaje.
    const turns = trimHistory([
      ...readHistory(request.data?.history),
      { role: "user" as const, text: rawText },
    ]);

    let reply: string;
    try {
      reply = await provider.generate(turns, AI_SYSTEM_PROMPT);
    } catch (error) {
      logger.error("aiChat: el proveedor falló", error);
      throw new HttpsError(
        "internal",
        "Loki no pudo responder ahora. Inténtalo de nuevo.",
      );
    }

    // 5) Persistencia con Admin SDK (nunca con el SDK del cliente).
    const messageId = await writeAiMessage(uid, chatId, reply);
    logger.info("aiChat: respuesta escrita", {
      uid,
      chatId,
      messageId,
      provider: provider.id,
      model: provider.model,
    });
    return {
      messageId,
      chatId,
      text: reply,
      provider: provider.id,
      model: provider.model,
    };
  },
);

// Las otras dos funciones del backend viven en su propio archivo y se
// re-exportan aquí (firebase solo despliega lo que exporta `index`).
export { onMention } from "./onMention";
export { smartReminders } from "./smartReminders";
