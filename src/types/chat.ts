import type { Timestamp } from "firebase/firestore";

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

export type MessageType = "user" | "ai" | "system" | "post";

export interface MessageAttachment {
  kind: "image" | "file";
  url: string;
  name: string;
  size: number;
  mime: string;
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
