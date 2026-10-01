"use client";

/**
 * Vínculos mensaje -> tarea/evento (`message_links`): el chip "✓ Tarea: …"
 * bajo el mensaje, con estado en vivo (si la tarea se completa, el chip
 * lo refleja). Solo chats accesibles (la RLS exige membresía del espacio).
 */

import * as React from "react";
import { getSupabaseClient } from "@/lib/supabase/client";

export type MessageLinkKind = "task" | "event";

export type MessageLink = {
  id: string;
  messageId: string;
  kind: MessageLinkKind;
  targetId: string;
  targetTitle: string;
  done: boolean;
};

async function fetchLinks(messageIds: string[]): Promise<MessageLink[]> {
  if (messageIds.length === 0) return [];
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("message_links")
    .select("id, message_id, kind, task_id, event_id")
    .in("message_id", messageIds.slice(0, 100));
  if (error !== null || data === null) return [];
  const rows = data as {
    id: string;
    message_id: string;
    kind: string;
    task_id: string | null;
    event_id: string | null;
  }[];
  const taskIds = rows.filter((r) => r.kind === "task" && r.task_id !== null).map((r) => r.task_id as string);
  const eventIds = rows.filter((r) => r.kind === "event" && r.event_id !== null).map((r) => r.event_id as string);
  const titles = new Map<string, { title: string; done: boolean }>();
  if (taskIds.length > 0) {
    const { data: tasks } = await client
      .from("tasks")
      .select("id, title, status")
      .in("id", taskIds);
    for (const t of (tasks ?? []) as { id: string; title: string; status: string }[]) {
      titles.set(`task:${t.id}`, { title: t.title, done: t.status === "done" });
    }
  }
  if (eventIds.length > 0) {
    const { data: events } = await client
      .from("events")
      .select("id, title")
      .in("id", eventIds);
    for (const e of (events ?? []) as { id: string; title: string }[]) {
      titles.set(`event:${e.id}`, { title: e.title, done: false });
    }
  }
  const out: MessageLink[] = [];
  for (const row of rows) {
    const targetId = row.kind === "task" ? row.task_id : row.event_id;
    if (targetId === null) continue;
    const info = titles.get(`${row.kind}:${targetId}`);
    // Sin acceso al destino (RLS) no se muestra el chip.
    if (info === undefined) continue;
    out.push({
      id: row.id,
      messageId: row.message_id,
      kind: row.kind as MessageLinkKind,
      targetId,
      targetTitle: info.title,
      done: info.done,
    });
  }
  return out;
}

export async function createMessageLink(input: {
  workspaceId: string;
  messageId: string;
  kind: MessageLinkKind;
  targetId: string;
  uid: string;
}): Promise<void> {
  const { error } = await getSupabaseClient().from("message_links").insert({
    workspace_id: input.workspaceId,
    message_id: input.messageId,
    kind: input.kind,
    task_id: input.kind === "task" ? input.targetId : null,
    event_id: input.kind === "event" ? input.targetId : null,
    created_by: input.uid,
  });
  if (error !== null) {
    throw new Error("No se pudo vincular con el mensaje.");
  }
}

/**
 * Vínculos de un mensaje + estado en vivo del destino (tarea completada,
 * evento borrado). Sin bucles: una query + realtime sobre message_links.
 */
export function useMessageLinks(messageId: string | null): MessageLink[] {
  const [links, setLinks] = React.useState<MessageLink[]>([]);

  React.useEffect(() => {
    if (messageId === null || messageId === "") {
      setLinks([]);
      return;
    }
    let cancelled = false;
    void fetchLinks([messageId]).then((rows) => {
      if (!cancelled) setLinks(rows);
    });
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`loki:links:${messageId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "message_links", filter: `message_id=eq.${messageId}` },
      () => {
        void fetchLinks([messageId]).then((rows) => {
          if (!cancelled) setLinks(rows);
        });
      },
    );
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "tasks" },
      () => {
        void fetchLinks([messageId]).then((rows) => {
          if (!cancelled) setLinks(rows);
        });
      },
    );
    channel.subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [messageId]);

  return links;
}
