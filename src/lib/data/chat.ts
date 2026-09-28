"use client";

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
  type UpdateData,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase/firestore";
import {
  LOKI_CANDIDATE,
  type MentionCandidate,
} from "@/lib/chat/mentions";
import type {
  ChatDoc,
  MessageAttachment,
  MessageDoc,
  MessageReplyRef,
  ReadReceiptDoc,
  TypingDoc,
} from "@/types/chat";
import type { WorkspaceMember } from "@/types/models";

export const MESSAGES_PAGE_SIZE = 30;

function chatsCollection(wsId: string) {
  return collection(getDb(), "workspaces", wsId, "chats");
}

function messagesCollection(wsId: string, chatId: string) {
  return collection(getDb(), "workspaces", wsId, "chats", chatId, "messages");
}

function aiMessagesCollection(uid: string, chatId: string) {
  return collection(getDb(), "users", uid, "aiChats", chatId, "messages");
}

function toChatDoc(id: string, data: DocumentData): ChatDoc {
  return { ...(data as Omit<ChatDoc, "id">), id };
}

function toMessageDoc(id: string, data: DocumentData): MessageDoc {
  return { ...(data as Omit<MessageDoc, "id">), id };
}

/** Genera un id de cliente para poder hacer envío optimista luego. */
export function newChatId(wsId: string): string {
  return doc(chatsCollection(wsId)).id;
}

/** Genera un id de mensaje de cliente para poder hacer envío optimista luego. */
export function newMessageId(wsId: string, chatId: string): string {
  return doc(messagesCollection(wsId, chatId)).id;
}

function mergeChatsDedup(chats: ChatDoc[]): ChatDoc[] {
  const seen = new Map<string, ChatDoc>();
  for (const chat of chats) {
    if (!seen.has(chat.id)) {
      seen.set(chat.id, chat);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const left = a.updatedAt?.toMillis() ?? 0;
    const right = b.updatedAt?.toMillis() ?? 0;
    if (left !== right) return right - left;
    return a.id.localeCompare(b.id);
  });
}

export function listenChats(
  wsId: string,
  uid: string,
  cb: (chats: ChatDoc[]) => void,
): Unsubscribe {
  // Las reglas de list exigen canAccessChat(resource.data):
  // type in [group, posts] OR uid in memberIds. Firestore no permite
  // una query sin filtros porque evaluaria docs inaccesibles (ej. dm
  // ajenos). Se usan dos queries probables por las reglas y se une en cliente.
  const base = chatsCollection(wsId);
  const qA = query(
    base,
    where("type", "in", ["group", "posts"]),
    orderBy("updatedAt", "desc"),
  );
  const qB = query(
    base,
    where("memberIds", "array-contains", uid),
    orderBy("updatedAt", "desc"),
  );
  let docsA: ChatDoc[] = [];
  let docsB: ChatDoc[] = [];
  const emit = () => {
    cb(mergeChatsDedup([...docsA, ...docsB]));
  };
  const unsubA = onSnapshot(qA, (snapshot) => {
    docsA = snapshot.docs.map((item) => toChatDoc(item.id, item.data({ serverTimestamps: "estimate" })));
    emit();
  });
  const unsubB = onSnapshot(qB, (snapshot) => {
    docsB = snapshot.docs.map((item) => toChatDoc(item.id, item.data({ serverTimestamps: "estimate" })));
    emit();
  });
  return () => {
    unsubA();
    unsubB();
  };
}

export async function fetchChats(wsId: string, uid: string): Promise<ChatDoc[]> {
  const base = chatsCollection(wsId);
  const [snapA, snapB] = await Promise.all([
    getDocs(
      query(
        base,
        where("type", "in", ["group", "posts"]),
        orderBy("updatedAt", "desc"),
      ),
    ),
    getDocs(
      query(
        base,
        where("memberIds", "array-contains", uid),
        orderBy("updatedAt", "desc"),
      ),
    ),
  ]);
  return mergeChatsDedup(
    [...snapA.docs, ...snapB.docs].map((item) =>
      toChatDoc(item.id, item.data({ serverTimestamps: "estimate" })),
    ),
  );
}

function latestMessagesQuery(wsId: string, chatId: string, pageSize = MESSAGES_PAGE_SIZE) {
  return query(
    messagesCollection(wsId, chatId),
    where("threadParentId", "==", null),
    orderBy("createdAt", "desc"),
    limit(pageSize),
  );
}

// --- Miembros (T15: candidatos de mención) -----------------------------------

function membersCollection(wsId: string) {
  return collection(getDb(), "workspaces", wsId, "members");
}

function toMemberDoc(data: DocumentData): WorkspaceMember {
  return data as WorkspaceMember;
}

/** Miembros del espacio ordenados por nombre (tope 100 para el menú @). */
export async function listMembers(wsId: string): Promise<WorkspaceMember[]> {
  const snapshot = await getDocs(
    query(membersCollection(wsId), orderBy("displayName", "asc"), limit(100)),
  );
  return snapshot.docs.map((item) =>
    toMemberDoc(item.data({ serverTimestamps: "estimate" })),
  );
}

/** Suscripción en vivo a los miembros del espacio. */
export function listenMembers(
  wsId: string,
  cb: (members: WorkspaceMember[]) => void,
): Unsubscribe {
  const q = query(
    membersCollection(wsId),
    orderBy("displayName", "asc"),
    limit(100),
  );
  return onSnapshot(q, (snapshot) => {
    cb(
      snapshot.docs.map((item) =>
        toMemberDoc(item.data({ serverTimestamps: "estimate" })),
      ),
    );
  });
}

/** Miembros -> candidatos de mención ordenados (sin duplicar uid). */
export function membersToCandidates(
  members: readonly WorkspaceMember[],
): MentionCandidate[] {
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];
  for (const member of members) {
    if (seen.has(member.uid)) continue;
    seen.add(member.uid);
    const name = member.displayName.trim();
    out.push({
      id: member.uid,
      displayName: name === "" ? "Miembro" : name,
    });
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
  return out;
}

/** Candidatos del menú @: entrada fija de Loki primero + miembros. */
export function mentionCandidatesWithLoki(
  members: readonly WorkspaceMember[],
): MentionCandidate[] {
  return [LOKI_CANDIDATE, ...membersToCandidates(members)];
}

/**
 * Suscripción en vivo a los últimos 30 mensajes del timeline principal.
 * El callback recibe los mensajes en orden ascendente y los snapshots
 * en bruto (orden descendente) para paginar hacia atrás.
 */
export function listenLatestMessages(
  wsId: string,
  chatId: string,
  cb: (messages: MessageDoc[], snapshots: QueryDocumentSnapshot<DocumentData>[]) => void,
): Unsubscribe {
  return onSnapshot(latestMessagesQuery(wsId, chatId), (snapshot) => {
    const ascending = [...snapshot.docs].reverse();
    cb(
      ascending.map((item) => toMessageDoc(item.id, item.data({ serverTimestamps: "estimate" }))),
      [...snapshot.docs],
    );
  });
}

export type OlderMessagesPage = {
  messages: MessageDoc[];
  snapshots: QueryDocumentSnapshot<DocumentData>[];
  hasMore: boolean;
};

export async function fetchOlderMessages(
  wsId: string,
  chatId: string,
  before: QueryDocumentSnapshot<DocumentData> | null,
  pageSize = MESSAGES_PAGE_SIZE,
): Promise<OlderMessagesPage> {
  const base = messagesCollection(wsId, chatId);
  const q =
    before === null
      ? query(
          base,
          where("threadParentId", "==", null),
          orderBy("createdAt", "desc"),
          limit(pageSize),
        )
      : query(
          base,
          where("threadParentId", "==", null),
          orderBy("createdAt", "desc"),
          startAfter(before),
          limit(pageSize),
        );
  const snapshot = await getDocs(q);
  const ascending = [...snapshot.docs].reverse();
  return {
    messages: ascending.map((item) => toMessageDoc(item.id, item.data({ serverTimestamps: "estimate" }))),
    snapshots: [...snapshot.docs],
    hasMore: snapshot.docs.length === pageSize,
  };
}

export function listenThread(
  wsId: string,
  chatId: string,
  parentId: string,
  cb: (messages: MessageDoc[]) => void,
): Unsubscribe {
  const q = query(
    messagesCollection(wsId, chatId),
    where("threadParentId", "==", parentId),
    orderBy("createdAt", "asc"),
    limit(100),
  );
  return onSnapshot(q, (snapshot) => {
    cb(snapshot.docs.map((item) => toMessageDoc(item.id, item.data({ serverTimestamps: "estimate" }))));
  });
}

export type SendMessageInput = {
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
  replyTo?: MessageReplyRef | null;
  threadParentId?: string | null;
  attachments?: MessageAttachment[];
  type?: "user" | "post" | "system";
  /**
   * Id de cliente para envío optimista y reintentos: si se pasa, el
   * mensaje se escribe con ese id (set con el mismo id al reintentar).
   */
  messageId?: string;
};

export async function sendMessage(
  wsId: string,
  chatId: string,
  input: SendMessageInput,
): Promise<string> {
  const text = input.text.trim();
  if (text === "") {
    throw new Error("Escribe un mensaje primero.");
  }
  if (text.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  const type = input.type ?? "user";
  const threadParentId = input.threadParentId ?? null;
  const db = getDb();
  const messageRef =
    input.messageId !== undefined && input.messageId !== ""
      ? doc(messagesCollection(wsId, chatId), input.messageId)
      : doc(messagesCollection(wsId, chatId));
  const batch = writeBatch(db);
  batch.set(messageRef, {
    authorId: input.authorId,
    authorName: input.authorName,
    text,
    mentions: input.mentions ?? [],
    replyTo: input.replyTo ?? null,
    threadParentId,
    threadCount: 0,
    lastReplyAt: null,
    attachments: input.attachments ?? [],
    reactions: {},
    lastReaction: null,
    createdAt: serverTimestamp(),
    editedAt: null,
    deleted: false,
    type,
  });
  if (threadParentId === null) {
    batch.update(doc(db, "workspaces", wsId, "chats", chatId), {
      lastMessage: {
        text,
        authorId: input.authorId,
        authorName: input.authorName,
        type,
        createdAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    });
  } else {
    // Una respuesta de hilo NO toca el doc del chat: el preview de la
    // lista (lastMessage/updatedAt) sigue siendo el del último mensaje del
    // timeline. Solo sube el contador del padre. El batch sigue
    // permitido por las reglas (create del mensaje + update del padre
    // con threadCount +1 exacto), asi que firestore.rules no cambia.
    batch.update(doc(messagesCollection(wsId, chatId), threadParentId), {
      threadCount: increment(1),
      lastReplyAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return messageRef.id;
}

export async function editMessage(
  wsId: string,
  chatId: string,
  messageId: string,
  text: string,
  mentions?: string[],
): Promise<void> {
  const next = text.trim();
  if (next === "") {
    throw new Error("El mensaje no puede quedar vacío. Bórralo si prefieres.");
  }
  if (next.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  const patch: UpdateData<DocumentData> = {
    text: next,
    editedAt: serverTimestamp(),
  };
  if (mentions !== undefined) {
    patch.mentions = mentions;
  }
  await updateDoc(
    doc(messagesCollection(wsId, chatId), messageId),
    patch,
  );
}

/** Borrado suave: marca deleted y vacía el texto. */
export async function deleteMessage(
  wsId: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  await updateDoc(doc(messagesCollection(wsId, chatId), messageId), {
    deleted: true,
    text: "",
    editedAt: serverTimestamp(),
  });
}

export async function toggleReaction(
  wsId: string,
  chatId: string,
  messageId: string,
  emoji: string,
  uid: string,
  hasReacted: boolean,
): Promise<void> {
  const field = `reactions.${emoji}`;
  await updateDoc(doc(messagesCollection(wsId, chatId), messageId), {
    [field]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    lastReaction: { uid, emoji },
  });
}

export type CreateDmInput = {
  name: string;
  memberIds: string[];
  createdBy: string;
  emoji?: string;
};

export async function createDm(
  wsId: string,
  input: CreateDmInput,
): Promise<string> {
  const name = input.name.trim();
  if (name === "" || name.length > 60) {
    throw new Error("El nombre del chat debe tener entre 1 y 60 caracteres.");
  }
  if (!input.memberIds.includes(input.createdBy)) {
    throw new Error("El creador debe ser miembro del chat directo.");
  }
  const db = getDb();
  const chatRef = doc(chatsCollection(wsId));
  const payload: DocumentData = {
    type: "dm",
    name,
    memberIds: input.memberIds,
    createdBy: input.createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastMessage: null,
  };
  if (input.emoji !== undefined) {
    payload.emoji = input.emoji;
  }
  await writeBatch(db)
    .set(chatRef, payload)
    .commit();
  return chatRef.id;
}

export function listenAiMessages(
  uid: string,
  chatId: string,
  cb: (messages: MessageDoc[]) => void,
): Unsubscribe {
  const q = query(
    aiMessagesCollection(uid, chatId),
    orderBy("createdAt", "asc"),
    limit(100),
  );
  return onSnapshot(q, (snapshot) => {
    cb(snapshot.docs.map((item) => toMessageDoc(item.id, item.data({ serverTimestamps: "estimate" }))));
  });
}

export async function sendAiUserMessage(
  uid: string,
  chatId: string,
  input: { authorId: string; authorName: string; text: string },
): Promise<string> {
  const text = input.text.trim();
  if (text === "") {
    throw new Error("Escribe un mensaje primero.");
  }
  if (text.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  const db = getDb();
  const messageRef = doc(aiMessagesCollection(uid, chatId));
  const batch = writeBatch(db);
  batch.set(messageRef, {
    authorId: input.authorId,
    authorName: input.authorName,
    text,
    mentions: [],
    replyTo: null,
    threadParentId: null,
    threadCount: 0,
    lastReplyAt: null,
    attachments: [],
    reactions: {},
    lastReaction: null,
    createdAt: serverTimestamp(),
    editedAt: null,
    deleted: false,
    type: "user",
  });
  batch.set(
    doc(db, "users", uid, "aiChats", chatId),
    { updatedAt: serverTimestamp() },
    { merge: true },
  );
  await batch.commit();
  return messageRef.id;
}

// --- Typing (T14) -----------------------------------------------------------

function typingCollection(wsId: string, chatId: string) {
  return collection(
    getDb(),
    "workspaces",
    wsId,
    "chats",
    chatId,
    "typing",
  );
}

function toTypingDoc(uid: string, data: DocumentData): TypingDoc {
  return { uid, ...(data as Omit<TypingDoc, "uid">) };
}

/** Marca que el usuario está escribiendo (el throttle lo hace el hook). */
export async function setTyping(
  wsId: string,
  chatId: string,
  uid: string,
  displayName: string,
): Promise<void> {
  const name = displayName.trim() === "" ? "Miembro" : displayName.trim();
  await setDoc(doc(typingCollection(wsId, chatId), uid), {
    displayName: name.slice(0, 40),
    updatedAt: serverTimestamp(),
  });
}

/** Borra la marca de escritura (input vacío o desmontaje). */
export async function clearTyping(
  wsId: string,
  chatId: string,
  uid: string,
): Promise<void> {
  try {
    await deleteDoc(doc(typingCollection(wsId, chatId), uid));
  } catch {
    // Borrar una marca inexistente o sin red no bloquea la salida.
  }
}

/** Suscripción en vivo a quién está escribiendo en el chat. */
export function listenTyping(
  wsId: string,
  chatId: string,
  cb: (typing: TypingDoc[]) => void,
): Unsubscribe {
  return onSnapshot(typingCollection(wsId, chatId), (snapshot) => {
    cb(
      snapshot.docs.map((item) =>
        toTypingDoc(item.id, item.data({ serverTimestamps: "estimate" })),
      ),
    );
  });
}

// --- Lecturas (T14) ---------------------------------------------------------

function readsCollection(wsId: string, chatId: string) {
  return collection(getDb(), "workspaces", wsId, "chats", chatId, "reads");
}

function toReadReceiptDoc(uid: string, data: DocumentData): ReadReceiptDoc {
  return { uid, ...(data as Omit<ReadReceiptDoc, "uid">) };
}

/** Guarda mi marca de lectura (solo mi doc reads/{uid}). */
export async function markChatRead(
  wsId: string,
  chatId: string,
  uid: string,
  lastReadMessageId: string | null,
): Promise<void> {
  await setDoc(
    doc(readsCollection(wsId, chatId), uid),
    {
      lastReadAt: serverTimestamp(),
      lastReadMessageId,
    },
    { merge: true },
  );
}

/** Suscripción a mi marca de lectura de un chat (null si nunca lo abrí). */
export function listenMyRead(
  wsId: string,
  chatId: string,
  uid: string,
  cb: (read: ReadReceiptDoc | null) => void,
): Unsubscribe {
  return onSnapshot(doc(readsCollection(wsId, chatId), uid), (snapshot) => {
    if (!snapshot.exists()) {
      cb(null);
      return;
    }
    cb(
      toReadReceiptDoc(
        snapshot.id,
        snapshot.data({ serverTimestamps: "estimate" }),
      ),
    );
  });
}

/**
 * Cuenta mensajes del timeline principal más nuevos que `since`
 * (excluyendo los míos). Sin filtro de fecha en servidor para no pedir
 * índices nuevos: trae los últimos 50 y filtra en cliente.
 */
export async function fetchUnreadCount(
  wsId: string,
  chatId: string,
  uid: string,
  sinceMs: number | null,
): Promise<number> {
  const snapshot = await getDocs(
    query(
      messagesCollection(wsId, chatId),
      where("threadParentId", "==", null),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
  );
  let count = 0;
  for (const item of snapshot.docs) {
    const data = item.data({ serverTimestamps: "estimate" });
    if (data.authorId === uid) continue;
    if (sinceMs === null) {
      count += 1;
      continue;
    }
    try {
      const ms =
        typeof data.createdAt?.toMillis === "function"
          ? (data.createdAt.toMillis() as number)
          : 0;
      if (ms > sinceMs) count += 1;
    } catch {
      count += 1;
    }
  }
  return count;
}

/** Lee mi marca de lectura una vez (para el E2E y revalidaciones). */
export async function fetchMyRead(
  wsId: string,
  chatId: string,
  uid: string,
): Promise<ReadReceiptDoc | null> {
  const snapshot = await getDoc(doc(readsCollection(wsId, chatId), uid));
  if (!snapshot.exists()) return null;
  return toReadReceiptDoc(
    snapshot.id,
    snapshot.data({ serverTimestamps: "estimate" }),
  );
}
