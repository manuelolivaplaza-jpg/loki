/**
 * T18: escritura en Firestore con **Admin SDK** (`firebase-admin`).
 *
 * IMPORTANTE — por qué el Admin SDK y no el cliente:
 * las reglas (`firestore.rules`) prohíben que el cliente escriba
 * `type: "ai"` en los chats de ESPACIO
 * (`workspaces/{wsId}/chats/{chatId}/messages`): solo se admite
 * `['user', 'post', 'system']` y con `authorId == request.auth.uid`. La
 * respuesta de la IA es del backend, así que la escribe aquí, saltándose
 * las reglas a propósito (privilegio de Admin) y nunca desde la app.
 *
 * Lo único que el cliente puede escribir con `type: "ai"` es su propio
 * chat privado `users/{uid}/aiChats/{chatId}/messages`, y solo se usa para
 * el MOCK de la fase 1-2 (ver `sendAiAssistantMessage` en la app).
 */

import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/** `authorId` de los mensajes `type: "ai"`: no es un uid real de persona. */
export const AI_AUTHOR_ID = "loki";

/** Nombre visible de la IA en la burbuja ("Loki" + icono Sparkles). */
export const AI_AUTHOR_NAME = "Loki";

/** Tope de caracteres de una respuesta de la IA. */
export const AI_MAX_REPLY_CHARS = 4000;

/** App de Admin del proceso (id por defecto), inicializada una sola vez. */
function adminApp(): App {
  const apps = getApps();
  return apps.length > 0 ? apps[0] : initializeApp();
}

/** Instancia de Firestore del proyecto (creada perezosa). */
export function db(): Firestore {
  return getFirestore(adminApp());
}

/** Id de chat de IA seguro para usarlo en una ruta de documento. */
export function safeId(value: string, fallback: string): string {
  const clean = value.trim();
  if (clean === "") return fallback;
  return /^[A-Za-z0-9_-]{1,64}$/.test(clean) ? clean : fallback;
}

function assertReply(text: string): string {
  const clean = text.trim();
  if (clean === "") {
    throw new Error("La IA devolvió una respuesta vacía.");
  }
  return clean.slice(0, AI_MAX_REPLY_CHARS);
}

/** Cuerpo completo de un mensaje, igual que escribe la app (`src/types/chat.ts`). */
function messageBody(text: string, mentions: readonly string[]): Record<string, unknown> {
  return {
    authorId: AI_AUTHOR_ID,
    authorName: AI_AUTHOR_NAME,
    text,
    mentions: [...mentions],
    replyTo: null,
    threadParentId: null,
    threadCount: 0,
    lastReplyAt: null,
    attachments: [],
    reactions: {},
    lastReaction: null,
    createdAt: new Date(),
    editedAt: null,
    deleted: false,
    type: "ai",
  };
}

/**
 * Escribe la respuesta de Loki en el chat privado del usuario
 * (`users/{uid}/aiChats/{chatId}/messages`) y actualiza `updatedAt` del
 * doc del chat. Devuelve el id del mensaje creado.
 */
export async function writeAiMessage(
  uid: string,
  chatId: string,
  text: string,
  mentions: readonly string[] = [],
): Promise<string> {
  const database = db();
  const chatRef = database.collection("users").doc(uid).collection("aiChats").doc(chatId);
  const messageRef = chatRef.collection("messages").doc();
  const batch = database.batch();
  batch.set(messageRef, messageBody(assertReply(text), mentions));
  batch.set(chatRef, { updatedAt: new Date() }, { merge: true });
  await batch.commit();
  return messageRef.id;
}

/**
 * Escribe la respuesta de Loki en un chat de ESPACIO
 * (`workspaces/{wsId}/chats/{chatId}/messages`) y refresca `lastMessage` /
 * `updatedAt` del chat para que la lista de la izquierda la muestre.
 *
 * El Admin SDK ignora las reglas: esta es la única vía para `type: "ai"`
 * en espacios (el cliente lo tiene prohibido).
 */
export async function writeWorkspaceAiMessage(
  wsId: string,
  chatId: string,
  text: string,
  mentions: readonly string[] = [],
): Promise<string> {
  const database = db();
  const chatRef = database.collection("workspaces").doc(wsId).collection("chats").doc(chatId);
  const messageRef = chatRef.collection("messages").doc();
  const reply = assertReply(text);
  const now = new Date();
  const batch = database.batch();
  batch.set(messageRef, messageBody(reply, mentions));
  batch.set(
    chatRef,
    {
      lastMessage: {
        text: reply.slice(0, 140),
        authorId: AI_AUTHOR_ID,
        authorName: AI_AUTHOR_NAME,
        type: "ai",
        createdAt: now,
      },
      updatedAt: now,
    },
    { merge: true },
  );
  await batch.commit();
  return messageRef.id;
}
