"use client";

/**
 * Cola offline de listas (el súper sin señal): agregar y marcar ítems se
 * encolan en localStorage y se sincronizan al volver la red, con el mismo
 * patrón que `outbox.ts` (ids de cliente, orden, best effort sin lanzar).
 */

import * as React from "react";
import { addListItem, setItemChecked, type NewListItem } from "@/lib/data/lists";

export type ListOp =
  | {
    id: string;
    op: "add";
    listId: string;
    wsId: string;
    uid: string;
    input: NewListItem;
    createdAt: string;
  }
  | {
    id: string;
    op: "check";
    listId: string;
    wsId: string;
    uid: string;
    itemId: string;
    checked: boolean;
    createdAt: string;
  };

const STORAGE_KEY = "loki:list-outbox:v1";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `listop-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function isOp(value: unknown): value is ListOp {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw["id"] !== "string" ||
    typeof raw["listId"] !== "string" ||
    typeof raw["wsId"] !== "string" ||
    typeof raw["uid"] !== "string" ||
    typeof raw["createdAt"] !== "string"
  ) {
    return false;
  }
  if (raw["op"] === "add") {
    const input = raw["input"];
    return typeof input === "object" && input !== null &&
      typeof (input as Record<string, unknown>)["text"] === "string";
  }
  if (raw["op"] === "check") {
    return typeof raw["itemId"] === "string" && typeof raw["checked"] === "boolean";
  }
  return false;
}

export function readListOutbox(): ListOp[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOp).slice(0, 100);
  } catch {
    return [];
  }
}

function writeListOutbox(ops: ListOp[]): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
  } catch {
    // Cuota llena: se pierde la cola (la UI ya avisó).
  }
}

export type EnqueueListOpInput =
  | {
      op: "add";
      listId: string;
      wsId: string;
      uid: string;
      input: NewListItem;
    }
  | {
      op: "check";
      listId: string;
      wsId: string;
      uid: string;
      itemId: string;
      checked: boolean;
    };

export function enqueueListOp(op: EnqueueListOpInput): ListOp {
  const item = { ...op, id: newId(), createdAt: new Date().toISOString() } as ListOp;
  writeListOutbox([...readListOutbox(), item]);
  return item;
}

function removeListOp(id: string): void {
  writeListOutbox(readListOutbox().filter((op) => op.id !== id));
}

export function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("fetch") || message.includes("red") || message.includes("network");
}

/** Reintenta la cola en orden. No lanza; devuelve pendientes. */
export async function flushListOutbox(): Promise<number> {
  const snapshot = readListOutbox();
  for (const op of snapshot) {
    try {
      if (op.op === "add") {
        await addListItem(op.listId, op.wsId, op.uid, op.input);
      } else {
        await setItemChecked(op.itemId, op.uid, op.checked);
      }
      removeListOp(op.id);
    } catch {
      // Sigue sin red o falló: queda para el próximo intento.
    }
  }
  return readListOutbox().length;
}

/** Sincroniza al volver la red; expone pendientes para avisar en la UI. */
export function useListOutboxSync(): { pending: number } {
  const [pending, setPending] = React.useState(0);

  React.useEffect(() => {
    setPending(readListOutbox().length);
    const sync = (): void => {
      void flushListOutbox().then(setPending).catch(() => undefined);
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) setPending(readListOutbox().length);
    };
    window.addEventListener("online", sync);
    window.addEventListener("storage", onStorage);
    // Al montar también (por si volvió la red con la app cerrada).
    void flushListOutbox().then(setPending).catch(() => undefined);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { pending };
}
