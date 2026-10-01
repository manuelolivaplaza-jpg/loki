"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { sendMessage } from "@/lib/data/chat";
import { useChats } from "@/hooks/use-chat";
import type { ShoppingList } from "@/types/organizer";

/**
 * Compartir lista en un chat como tarjeta viva (mensaje 'card' con
 * meta {kind:"list", list_id}): progreso en vivo y marcar desde el chat.
 */
export function ShareListDialog({
  open,
  list,
  wsId,
  uid,
  authorName,
  onClose,
}: {
  open: boolean;
  list: ShoppingList | null;
  wsId: string;
  uid: string | null;
  authorName: string;
  onClose: () => void;
}): React.JSX.Element | null {
  const chatsQuery = useChats(wsId === "" ? null : wsId);
  const [chatId, setChatId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  const chats = (chatsQuery.data ?? []).filter(
    (chat) => chat.type === "group" || chat.type === "posts",
  );

  React.useEffect(() => {
    if (open) {
      setChatId("");
      setError(null);
    }
  }, [open ]);

  async function handleShare(): Promise<void> {
    const current = list;
    if (uid === null || chatId === "" || current === null) {
      setError(chatId === "" ? "Elige un chat." : "Tu sesión expiró.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      await sendMessage(wsId, chatId, {
        authorId: uid,
        authorName,
        text: `${current.emoji} ${current.title} (${current.open}/${current.total})`,
        type: "card",
        meta: { kind: "list", list_id: current.id },
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo compartir.");
    } finally {
      setSending(false);
    }
  }

  if (list === null) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogTitle>Compartir lista</DialogTitle>
        <DialogDescription>
          {list.emoji} {list.title}: tarjeta viva con progreso en el chat.
        </DialogDescription>
        <label className="flex flex-col gap-1">
          <span className="text-meta leading-4 text-muted-foreground">Chat</span>
          <select
            aria-label="Chat destino"
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
            className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
          >
            <option value="">Elige un chat…</option>
            {chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.emoji ?? ""} {chat.name}
              </option>
            ))}
          </select>
        </label>
        {error !== null ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void handleShare()}
          disabled={sending}
          className="min-h-11 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {sending ? "Compartiendo…" : "Compartir"}
        </button>
      </DialogContent>
    </Dialog>
  );
}
