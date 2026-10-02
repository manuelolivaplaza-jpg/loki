"use client";

/**
 * Resumen diario "Tu día": preferencias por usuario, datos deterministas del
 * día (eventos, tareas, listas, encuestas) y destacados con IA bajo demanda.
 *
 * La push la arma `create_daily_digests()` en la base (pg_cron cada 15 min,
 * sin LLM) y llega como notificación tipo `daily` con link
 * `/inicio?vista=dia`. Esta capa lee lo mismo para pintar la vista, y pide
 * los destacados (`ai_jobs` tipo `day_highlights`, cacheados por día en
 * `ai_summaries` con `chat_key = 'day:YYYY-MM-DD'`) solo al abrir.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type {
  DailyDigestPrefs,
  EventOccurrence,
  ListItem,
  PollKind,
  ShoppingList,
  TaskItem,
} from "@/types/organizer";
import { DEFAULT_DAILY_DIGEST_PREFS } from "@/types/organizer";

type PrefsRow = Database["public"]["Tables"]["daily_digest_prefs"]["Row"];

/** Zona del dispositivo (para el default editable de la preferencia). */
export function deviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz !== "" ? tz : "America/Santiago";
  } catch {
    return "America/Santiago";
  }
}

/** "8:00" / "08:00" → "08:00". Lo que no parsea, default. */
export function normalizeDigestTime(value: string | null): string {
  if (value === null) return DEFAULT_DAILY_DIGEST_PREFS.digestTime;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (match === null) return DEFAULT_DAILY_DIGEST_PREFS.digestTime;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const mins = Math.min(59, Math.max(0, Number(match[2])));
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

function toPrefs(row: PrefsRow): DailyDigestPrefs {
  const days = row.days === "weekdays" ? "weekdays" : "all";
  return {
    userId: row.user_id,
    enabled: row.enabled,
    digestTime: normalizeDigestTime(row.digest_time),
    timezone: row.timezone.trim() === "" ? "America/Santiago" : row.timezone,
    days,
    workspaceIds: (row.workspace_ids ?? []).filter((id) => id !== ""),
    sendWhenEmpty: row.send_when_empty,
  };
}

const PREFS_COLUMNS =
  "user_id, enabled, digest_time, timezone, days, workspace_ids, send_when_empty, updated_at";

export async function getDailyDigestPrefs(uid: string): Promise<DailyDigestPrefs> {
  const { data, error } = await getSupabaseClient()
    .from("daily_digest_prefs")
    .select(PREFS_COLUMNS)
    .eq("user_id", uid)
    .maybeSingle();
  if (error !== null || data === null) {
    return {
      userId: uid,
      ...DEFAULT_DAILY_DIGEST_PREFS,
      timezone: deviceTimezone(),
      workspaceIds: [],
    };
  }
  return toPrefs(data as PrefsRow);
}

export async function saveDailyDigestPrefs(prefs: DailyDigestPrefs): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("daily_digest_prefs")
    .upsert(
      {
        user_id: prefs.userId,
        enabled: prefs.enabled,
        digest_time: normalizeDigestTime(prefs.digestTime),
        timezone: prefs.timezone.trim() === "" ? "America/Santiago" : prefs.timezone.trim(),
        days: prefs.days,
        workspace_ids: prefs.workspaceIds,
        send_when_empty: prefs.sendWhenEmpty,
      },
      { onConflict: "user_id" },
    );
  if (error !== null) {
    throw new Error("No se pudieron guardar las preferencias del resumen.");
  }
}

// --- Datos deterministas del día -------------------------------------------------

export type TodayEvent = EventOccurrence;
export type TodayTask = TaskItem;
export type TodayList = { list: ShoppingList; open: number; total: number };
export type TodayPoll = {
  id: string;
  question: string;
  kind: PollKind;
  closesAt: Timestamp | null;
  workspaceId: string;
  chatId: string;
  messageId: string;
};

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfToday(): Date {
  return new Date(startOfToday().getTime() + 86_400_000);
}

/** Eventos de hoy del espacio (puntuales + recurrentes expandidos). */
export async function listTodayEvents(wsId: string): Promise<TodayEvent[]> {
  const { listEvents, occurrencesIn } = await import("@/lib/data/events");
  const from = startOfToday();
  const to = endOfToday();
  const events = await listEvents(wsId, from.toISOString(), to.toISOString());
  return occurrencesIn(events, from, to);
}

/** Tareas abiertas que vencen hoy o están atrasadas (mías o asignadas). */
export async function listTodayTasks(wsId: string, uid: string): Promise<{
  dueToday: TodayTask[];
  overdue: TodayTask[];
}> {
  const { listWorkspaceTasks } = await import("@/lib/data/projects");
  const tasks = await listWorkspaceTasks(wsId);
  const start = startOfToday().getTime();
  const end = start + 86_400_000;
  const mine = tasks.filter(
    (task) =>
      task.status !== "done" &&
      task.dueAt !== null &&
      (task.assigneeIds.includes(uid) || task.createdBy === uid),
  );
  const dueToday = mine
    .filter((task) => {
      const due = task.dueAt?.toMillis() ?? 0;
      return due >= start && due < end;
    })
    .sort((a, b) => (a.dueAt?.toMillis() ?? 0) - (b.dueAt?.toMillis() ?? 0));
  const overdue = mine
    .filter((task) => (task.dueAt?.toMillis() ?? 0) < start)
    .sort((a, b) => (a.dueAt?.toMillis() ?? 0) - (b.dueAt?.toMillis() ?? 0));
  return { dueToday, overdue };
}

/** Listas fijadas con pendientes (para "Tu día" y el resumen). */
export async function listPinnedListsWithPending(wsId: string): Promise<TodayList[]> {
  const { listShoppingLists, listItems } = await import("@/lib/data/lists");
  const lists = (await listShoppingLists(wsId)).filter((list) => list.pinned);
  const out: TodayList[] = [];
  for (const list of lists.slice(0, 10)) {
    const items: ListItem[] = await listItems(list.id).catch(() => []);
    const open = items.filter((item) => !item.checked).length;
    if (open > 0) out.push({ list, open, total: items.length });
  }
  return out;
}

/** Encuestas abiertas sin mi voto (para votar desde "Tu día"). */
export async function listOpenPollsWithoutVote(
  wsId: string,
  uid: string,
): Promise<TodayPoll[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("polls")
    .select("id, question, kind, closes_at, workspace_id, chat_id, message_id")
    .eq("workspace_id", wsId)
    .is("closed_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error !== null || data === null) return [];
  const rows = data as {
    id: string;
    question: string;
    kind: string;
    closes_at: string | null;
    workspace_id: string;
    chat_id: string;
    message_id: string;
  }[];
  const now = Date.now();
  const open = rows.filter(
    (row) => row.closes_at === null || new Date(row.closes_at).getTime() > now,
  );
  if (open.length === 0) return [];
  const { data: votes } = await client
    .from("poll_votes")
    .select("poll_id")
    .eq("user_id", uid)
    .in(
      "poll_id",
      open.map((row) => row.id),
    );
  const voted = new Set(
    ((votes ?? []) as { poll_id: string }[]).map((v) => v.poll_id),
  );
  return open
    .filter((row) => !voted.has(row.id))
    .map((row) => ({
      id: row.id,
      question: row.question,
      kind: (row.kind as PollKind) ?? "single",
      closesAt:
        row.closes_at === null ? null : Timestamp.fromDate(new Date(row.closes_at)),
      workspaceId: row.workspace_id,
      chatId: row.chat_id,
      messageId: row.message_id,
    }));
}

// --- Destacados con IA bajo demanda -----------------------------------------------

export type DayHighlights =
  | { status: "loading" }
  | { status: "unavailable"; detail: string }
  | { status: "empty" }
  | { status: "ready"; summary: string; detail: string; deterministic: boolean };

function dayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

/** Lee el cache del día (`ai_summaries` con `chat_key = 'day:YYYY-MM-DD'`). */
export async function getCachedDayHighlights(uid: string): Promise<DayHighlights | null> {
  const { data, error } = await getSupabaseClient()
    .from("ai_summaries")
    .select("summary")
    .eq("user_id", uid)
    .eq("chat_key", `day:${dayKey()}`)
    .maybeSingle();
  if (error !== null || data === null) return null;
  try {
    const parsed: unknown = JSON.parse((data as { summary: string }).summary);
    if (typeof parsed !== "object" || parsed === null) return null;
    const row = parsed as { empty?: boolean; deterministic?: boolean; detail?: string; summary?: string };
    if (row.empty === true) return { status: "empty" };
    const detail = typeof row.detail === "string" ? row.detail : "";
    const summary = typeof row.summary === "string" && row.summary !== "" ? row.summary : detail;
    if (summary === "") return { status: "empty" };
    return { status: "ready", summary, detail, deterministic: row.deterministic === true };
  } catch {
    return null;
  }
}

/**
 * Pide los destacados del día (un trabajo `day_highlights` por usuario y día;
 * el trigger `wake_ai_worker` despierta al worker y el resultado llega por
 * Realtime). Idempotente: si ya hay trabajo de hoy, espera a ese.
 */
export async function requestDayHighlights(wsId: string, uid: string): Promise<string> {
  const { requestAiJob } = await import("@/lib/data/ai-jobs");
  const today = dayKey();
  const { data } = await getSupabaseClient()
    .from("ai_jobs")
    .select("id")
    .eq("workspace_id", wsId)
    .eq("type", "day_highlights")
    .eq("requested_by", uid)
    .gte("created_at", `${today}T00:00:00`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const existing = (data as { id: string } | null)?.id;
  if (existing !== undefined && existing !== null && existing !== "") return existing;
  return requestAiJob(wsId, uid, "day_highlights", { user_id: uid, date: today }, `day:${uid}:${today}`);
}

export function listenDayHighlightsJob(
  jobId: string,
  cb: (done: boolean, failed: boolean) => void,
): () => void {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:day-highlights:${jobId}`);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "ai_jobs", filter: `id=eq.${jobId}` },
    (payload) => {
      const row = (payload as { new?: { status?: string } }).new;
      if (row?.status === "done") cb(true, false);
      else if (row?.status === "error" || row?.status === "cancelled") cb(true, true);
    },
  );
  channel.subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
