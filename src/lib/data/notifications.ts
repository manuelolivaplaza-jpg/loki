"use client";

/**
 * Notificaciones sobre Supabase: bandeja, conteo de no leídas, marcar como
 * leídas, preferencias por tipo + silencio, y suscripción en vivo (la tabla
 * está en la publicación de realtime).
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type {
  NotificationItem,
  NotificationPrefs,
  NotificationType,
} from "@/types/organizer";

type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];
type PrefsRow = Database["public"]["Tables"]["notification_prefs"]["Row"];

export type Unsubscribe = () => void;

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toNotification(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.read_at === null ? null : toTimestamp(row.read_at),
    createdAt: toTimestamp(row.created_at),
  };
}

export const DEFAULT_PREFS: NotificationPrefs = {
  mention: true,
  reply: true,
  reaction: true,
  task_assigned: true,
  task_due: true,
  event_reminder: true,
  invite: true,
  ai_alert: true,
  list: true,
  poll: true,
  memory: true,
  quietStart: null,
  quietEnd: null,
};

function toPrefs(row: PrefsRow): NotificationPrefs {
  return {
    mention: row.mention,
    reply: row.reply,
    reaction: row.reaction,
    task_assigned: row.task_assigned,
    task_due: row.task_due,
    event_reminder: row.event_reminder,
    invite: row.invite,
    ai_alert: row.ai_alert,
    list: row.list,
    poll: row.poll,
    memory: row.memory,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
  };
}

const NOTIFICATION_COLUMNS =
  "id, user_id, workspace_id, type, title, body, link, read_at, created_at";

export async function listNotifications(uid: string): Promise<NotificationItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("notifications")
    .select(NOTIFICATION_COLUMNS)
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error !== null) {
    throw new Error("No se pudieron cargar las notificaciones.");
  }
  return ((data ?? []) as NotificationRow[]).map(toNotification);
}

export async function unreadNotificationsCount(uid: string): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .is("read_at", null);
  if (error !== null) return 0;
  return count ?? 0;
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo marcar como leída.");
  }
}

export async function markAllNotificationsRead(uid: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", uid)
    .is("read_at", null);
  if (error !== null) {
    throw new Error("No se pudieron marcar como leídas.");
  }
}

export async function getNotificationPrefs(uid: string): Promise<NotificationPrefs> {
  const { data, error } = await getSupabaseClient()
    .from("notification_prefs")
    .select(
      "user_id, mention, reply, reaction, task_assigned, task_due, event_reminder, invite, ai_alert, list, poll, memory, quiet_start, quiet_end, updated_at",
    )
    .eq("user_id", uid)
    .maybeSingle();
  if (error !== null || data === null) return { ...DEFAULT_PREFS };
  return toPrefs(data as PrefsRow);
}

export async function saveNotificationPrefs(
  uid: string,
  prefs: NotificationPrefs,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("notification_prefs")
    .upsert(
      {
        user_id: uid,
        mention: prefs.mention,
        reply: prefs.reply,
        reaction: prefs.reaction,
        task_assigned: prefs.task_assigned,
        task_due: prefs.task_due,
        event_reminder: prefs.event_reminder,
        invite: prefs.invite,
        ai_alert: prefs.ai_alert,
        list: prefs.list,
        poll: prefs.poll,
        memory: prefs.memory,
        quiet_start: prefs.quietStart,
        quiet_end: prefs.quietEnd,
      },
      { onConflict: "user_id" },
    );
  if (error !== null) {
    throw new Error("No se pudieron guardar las preferencias.");
  }
}

/** ¿Estamos en horario de silencio? ("22:00"–"07:00", cruza medianoche). */
export function isQuietNow(prefs: NotificationPrefs, now = new Date()): boolean {
  if (prefs.quietStart === null || prefs.quietEnd === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
    if (match === null) return null;
    const hours = Number(match[1]);
    const mins = Number(match[2]);
    if (hours > 23 || mins > 59) return null;
    return hours * 60 + mins;
  };
  const start = parse(prefs.quietStart);
  const end = parse(prefs.quietEnd);
  if (start === null || end === null || start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export type NotificationGroup = "today" | "yesterday" | "older";

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Agrupa la bandeja en Hoy / Ayer / Antes (por fecha local). */
export function groupNotifications(
  items: NotificationItem[],
  now = new Date(),
): { group: NotificationGroup; items: NotificationItem[] }[] {
  const today = startOfDay(now).getTime();
  const buckets: Record<NotificationGroup, NotificationItem[]> = {
    today: [],
    yesterday: [],
    older: [],
  };
  for (const item of items) {
    const day = startOfDay(item.createdAt.toDate()).getTime();
    const diff = Math.round((today - day) / 86_400_000);
    if (diff <= 0) buckets.today.push(item);
    else if (diff === 1) buckets.yesterday.push(item);
    else buckets.older.push(item);
  }
  return (Object.keys(buckets) as NotificationGroup[])
    .map((group) => ({ group, items: buckets[group] }))
    .filter((entry) => entry.items.length > 0);
}

type NotificationsListener = (items: NotificationItem[]) => void;

type SharedSubscription = {
  refs: number;
  listeners: Set<NotificationsListener>;
  cancelled: boolean;
  unsubscribeChannel?: () => void;
};

/**
 * Una sola suscripción realtime por usuario, compartida entre campana, toast
 * y bandeja. `supabase.channel(topic)` devuelve la MISMA instancia si ya
 * existe, y añadir `.on()` después de `subscribe()` revienta la app
 * ("cannot add postgres_changes callbacks after subscribe"). Con este
 * registro el canal se crea una vez y cada montaje solo suma su callback.
 */
const sharedSubscriptions = new Map<string, SharedSubscription>();

function reloadNotifications(uid: string): void {
  const entry = sharedSubscriptions.get(uid);
  if (entry === undefined || entry.cancelled) return;
  void listNotifications(uid)
    .then((items) => {
      const current = sharedSubscriptions.get(uid);
      if (current === undefined || current.cancelled) return;
      for (const listener of current.listeners) {
        listener(items);
      }
    })
    .catch(() => undefined);
}

export function listenNotifications(
  uid: string,
  cb: NotificationsListener,
): Unsubscribe {
  const supabase = getSupabaseClient();
  let entry = sharedSubscriptions.get(uid);
  if (entry === undefined) {
    const fresh: SharedSubscription = {
      refs: 0,
      listeners: new Set(),
      cancelled: false,
    };
    sharedSubscriptions.set(uid, fresh);
    entry = fresh;
    try {
      const channel = supabase.channel(`loki:notifications:${uid}`);
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` },
        () => reloadNotifications(uid),
      );
      channel.subscribe();
      fresh.unsubscribeChannel = () => {
        void supabase.removeChannel(channel);
      };
    } catch {
      // Realtime caído: la bandeja sigue funcionando por query inicial.
      sharedSubscriptions.delete(uid);
      entry = undefined;
    }
  }
  if (entry === undefined) {
    void listNotifications(uid).then(cb).catch(() => undefined);
    return () => undefined;
  }
  entry.refs += 1;
  entry.listeners.add(cb);
  reloadNotifications(uid);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const current = sharedSubscriptions.get(uid);
    if (current === undefined) return;
    current.listeners.delete(cb);
    current.refs -= 1;
    if (current.refs <= 0) {
      current.cancelled = true;
      current.unsubscribeChannel?.();
      sharedSubscriptions.delete(uid);
    }
  };
}
