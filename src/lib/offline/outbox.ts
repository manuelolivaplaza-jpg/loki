"use client";

/**
 * Cola offline de mensajes (outbox) para el export estático.
 *
 * No hay backend propio que encole (el SW tampoco: es solo caché), así que
 * la cola vive en el cliente con localStorage: cada item guarda
 * {wsId, chatId, text, mentions, attachments, createdAt} más el id de
 * cliente (`messageId`, mismo id al reintentar → envío idempotente en
 * `sendMessage`) y el autor. Al volver online se reintenta con `sendMessage`
 * y lo enviado se borra.
 */

import * as React from "react";
import { sendMessage } from "@/lib/data/chat";
import type { MessageAttachment, MessageReplyRef } from "@/types/chat";

export type OutboxItem = {
  /** Id de cliente: se usa como `messageId` al reintentar (idempotente). */
  id: string;
  wsId: string;
  chatId: string;
  authorId: string;
  authorName: string;
  text: string;
  mentions: string[];
  attachments: MessageAttachment[];
  threadParentId: string | null;
  replyTo: MessageReplyRef | null;
  createdAt: string;
};

export type EnqueueOutboxInput = {
  wsId: string;
  chatId: string;
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
  attachments?: MessageAttachment[];
  threadParentId?: string | null;
  replyTo?: MessageReplyRef | null;
};

const STORAGE_KEY = "loki:outbox:v1";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `outbox-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function isAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    (raw["kind"] === "image" || raw["kind"] === "file") &&
    typeof raw["url"] === "string" &&
    typeof raw["name"] === "string" &&
    typeof raw["size"] === "number" &&
    typeof raw["mime"] === "string"
  );
}

function isReplyRef(value: unknown): value is MessageReplyRef | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw["id"] === "string" &&
    typeof raw["authorName"] === "string" &&
    typeof raw["text"] === "string"
  );
}

function isOutboxItem(value: unknown): value is OutboxItem {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw["id"] !== "string" ||
    typeof raw["wsId"] !== "string" ||
    typeof raw["chatId"] !== "string" ||
    typeof raw["authorId"] !== "string" ||
    typeof raw["authorName"] !== "string" ||
    typeof raw["text"] !== "string" ||
    !Array.isArray(raw["mentions"]) ||
    typeof raw["createdAt"] !== "string"
  ) {
    return false;
  }
  if (
    !raw["mentions"].every((item: unknown) => typeof item === "string")
  ) {
    return false;
  }
  if (
    raw["attachments"] !== undefined &&
    (!Array.isArray(raw["attachments"]) ||
      !raw["attachments"].every(isAttachment))
  ) {
    return false;
  }
  if (
    raw["threadParentId"] !== undefined &&
    raw["threadParentId"] !== null &&
    typeof raw["threadParentId"] !== "string"
  ) {
    return false;
  }
  return isReplyRef(raw["replyTo"] ?? null);
}

function normalizeItem(value: OutboxItem): OutboxItem {
  return {
    id: value.id,
    wsId: value.wsId,
    chatId: value.chatId,
    authorId: value.authorId,
    authorName: value.authorName,
    text: value.text,
    mentions: [...value.mentions],
    attachments: [...value.attachments],
    threadParentId: value.threadParentId,
    replyTo: value.replyTo,
    createdAt: value.createdAt,
  };
}

/** Lee la cola (vacía si no hay o si el JSON se corrompió). */
export function readOutbox(): OutboxItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOutboxItem).map(normalizeItem);
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Cuota llena o modo privado: la cola queda en memoria esta sesión.
  }
}

/**
 * Encola un mensaje para enviarlo cuando haya red. Devuelve el item con su
 * id de cliente (sirve para el envío optimista y los reintentos).
 */
export function enqueueOutboxMessage(input: EnqueueOutboxInput): OutboxItem {
  const item: OutboxItem = {
    id: newId(),
    wsId: input.wsId,
    chatId: input.chatId,
    authorId: input.authorId,
    authorName: input.authorName,
    text: input.text,
    mentions: [...(input.mentions ?? [])],
    attachments: [...(input.attachments ?? [])],
    threadParentId: input.threadParentId ?? null,
    replyTo: input.replyTo ?? null,
    createdAt: new Date().toISOString(),
  };
  writeOutbox([...readOutbox(), item]);
  return item;
}

/** Borra un item (llamar tras un `sendMessage` exitoso). */
export function removeOutboxMessage(id: string): void {
  writeOutbox(readOutbox().filter((item) => item.id !== id));
}

export type FlushResult = { sent: number; pending: number };

/**
 * Reintenta la cola con `sendMessage` en orden (mismo `messageId`, así el
 * reintento cuyo primer intento sí llegó se considera éxito). Los fallos de
 * red quedan encolados; no lanza.
 */
export async function flushOutbox(): Promise<FlushResult> {
  const snapshot = readOutbox();
  let sent = 0;
  for (const item of snapshot) {
    try {
      await sendMessage(item.wsId, item.chatId, {
        authorId: item.authorId,
        authorName: item.authorName,
        text: item.text,
        mentions: item.mentions,
        replyTo: item.replyTo,
        threadParentId: item.threadParentId,
        attachments: item.attachments,
        messageId: item.id,
      });
      removeOutboxMessage(item.id);
      sent += 1;
    } catch {
      // Sin red o error del servidor: queda encolado para el próximo intento.
    }
  }
  return { sent, pending: readOutbox().length };
}

export type UseOutbox = {
  items: OutboxItem[];
  pending: number;
  isOnline: boolean;
  enqueue: (input: EnqueueOutboxInput) => OutboxItem;
  flush: () => Promise<FlushResult>;
  remove: (id: string) => void;
};

/**
 * Estado vivo de la cola: carga inicial, eventos online/offline, sync entre
 * pestañas (evento `storage`) y reintento automático al volver la red.
 */
export function useOutbox(): UseOutbox {
  const [items, setItems] = React.useState<OutboxItem[]>([]);
  const [isOnline, setIsOnline] = React.useState<boolean>(
    () => (isBrowser() ? navigator.onLine : true),
  );

  const refresh = React.useCallback(() => {
    setItems(readOutbox());
  }, []);

  const flush = React.useCallback(async (): Promise<FlushResult> => {
    const result = await flushOutbox();
    refresh();
    return result;
  }, [refresh]);

  React.useEffect(() => {
    refresh();
    const onOnline = (): void => {
      setIsOnline(true);
      void flush();
    };
    const onOffline = (): void => {
      setIsOnline(false);
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
    };
  }, [flush, refresh]);

  const enqueue = React.useCallback(
    (input: EnqueueOutboxInput): OutboxItem => {
      const item = enqueueOutboxMessage(input);
      refresh();
      // Si hay red, intenta enviar enseguida (best effort).
      if (navigator.onLine) void flush();
      return item;
    },
    [flush, refresh],
  );

  const remove = React.useCallback(
    (id: string): void => {
      removeOutboxMessage(id);
      refresh();
    },
    [refresh],
  );

  return {
    items,
    pending: items.length,
    isOnline,
    enqueue,
    flush,
    remove,
  };
}
