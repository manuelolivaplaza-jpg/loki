import type { Timestamp } from "@/lib/timestamp";

export type ChatType = "group" | "dm" | "posts" | "ai";

export interface ChatLastMessage {
  text: string;
  authorId: string;
  authorName: string;
  type: string;
  createdAt: Timestamp;
}

export interface ChatDoc {
  id: string;
  type: ChatType;
  name: string;
  emoji?: string;
  /** En dm: uids con acceso. En group/posts: vacio = todo el espacio. */
  memberIds: string[];
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastMessage: ChatLastMessage | null;
}

export type MessageType = "user" | "ai" | "system" | "post" | "card";

/** Datos de tarjeta (lista viva, etc.). Nunca se renderiza como HTML. */
export type MessageMeta = {
  kind?: string;
  list_id?: string;
  [key: string]: unknown;
};

export type AttachmentKind = "image" | "video" | "audio" | "file";

export interface MessageAttachment {
  kind: AttachmentKind;
  url: string;
  name: string;
  size: number;
  mime: string;
  /** Ruta en el bucket (`{wsId}/...`), por si hay que borrar o re-firmar. */
  path?: string;
  /** Dimensiones originales (imagen/video). */
  width?: number;
  height?: number;
  /** Duración en segundos (audio/video/nota de voz). */
  duration?: number;
}

export interface MessageReplyRef {
  id: string;
  authorName: string;
  text: string;
}

export interface MessageLastReaction {
  uid: string;
  emoji: string;
}

export interface MessageDoc {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  /** Uids mencionados, o "loki" para la IA. */
  mentions: string[];
  replyTo: MessageReplyRef | null;
  /** Null en el timeline principal; id del padre en respuestas de hilo. */
  threadParentId: string | null;
  threadCount: number;
  lastReplyAt: Timestamp | null;
  attachments: MessageAttachment[];
  /** Emoji -> uids que reaccionaron. */
  reactions: Record<string, string[]>;
  lastReaction: MessageLastReaction | null;
  createdAt: Timestamp;
  editedAt: Timestamp | null;
  deleted: boolean;
  type: MessageType;
  /** Datos de tarjeta (`card`): p. ej. { kind: "list", list_id }. */
  meta?: MessageMeta | null;
}

export interface AiChatDoc {
  id: string;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Quién está escribiendo en un chat. Doc typing/{uid}. */
export interface TypingDoc {
  uid: string;
  displayName: string;
  updatedAt: Timestamp | null;
}

/** Marca de lectura por usuario. Doc reads/{uid}. */
export interface ReadReceiptDoc {
  uid: string;
  lastReadAt: Timestamp | null;
  lastReadMessageId: string | null;
}

/** Estado local de un mensaje en envío optimista. */
export type MessageSendStatus = "sending" | "error";
