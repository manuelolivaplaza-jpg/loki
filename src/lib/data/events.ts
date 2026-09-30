"use client";

/**
 * Eventos del calendario sobre Supabase.
 *
 * Lectura por ventana (los recurrentes se traen aparte y se expanden en el
 * cliente con `occurrencesIn`). La recurrencia es `daily|weekly|monthly` sin
 * fin: se expande solo sobre la ventana visible (tope 120 ocurrencias).
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type { EventItem, EventOccurrence, EventRecurrence } from "@/types/organizer";

type EventRow = Database["public"]["Tables"]["events"]["Row"];

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toEvent(row: EventRow): EventItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    startsAt: toTimestamp(row.starts_at),
    endsAt: toTimestamp(row.ends_at),
    allDay: row.all_day,
    location: row.location,
    color: row.color,
    createdBy: row.created_by ?? "",
    attendees: [...row.attendees],
    reminderMinutes: [...row.reminder_minutes],
    recurrence: (row.recurrence ?? null) as EventRecurrence | null,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function eventErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42501"
  ) {
    return "No tienes permiso para eso en este espacio.";
  }
  return "No se pudo guardar el evento. Inténtalo de nuevo.";
}

const EVENT_COLUMNS =
  "id, workspace_id, project_id, title, description, starts_at, ends_at, all_day, location, color, created_by, attendees, reminder_minutes, recurrence, created_at, updated_at";

/**
 * Eventos que tocan la ventana [from, to] (puntuales) más los recurrentes que
 * empiezan antes del fin (se expanden con `occurrencesIn`).
 */
export async function listEvents(
  wsId: string,
  fromISO: string,
  toISO: string,
): Promise<EventItem[]> {
  const supabase = getSupabaseClient();
  const [oneshots, recurring] = await Promise.all([
    supabase
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("workspace_id", wsId)
      .lte("starts_at", toISO)
      .gte("ends_at", fromISO)
      .order("starts_at", { ascending: true })
      .limit(500),
    supabase
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("workspace_id", wsId)
      .not("recurrence", "is", null)
      .lte("starts_at", toISO)
      .order("starts_at", { ascending: true })
      .limit(200),
  ]);
  if (oneshots.error !== null || recurring.error !== null) {
    throw new Error("No se pudieron cargar los eventos.");
  }
  const seen = new Set<string>();
  const rows: EventRow[] = [];
  for (const row of [...((oneshots.data ?? []) as EventRow[]), ...((recurring.data ?? []) as EventRow[])]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows.map(toEvent);
}

export type CreateEventInput = {
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  location?: string;
  color?: string;
  projectId?: string | null;
  attendees?: string[];
  reminderMinutes?: number[];
  recurrence?: EventRecurrence | null;
};

export async function createEvent(
  wsId: string,
  uid: string,
  input: CreateEventInput,
): Promise<string> {
  const title = input.title.trim();
  if (title === "") throw new Error("Ponle un título al evento.");
  if (input.endsAt.getTime() < input.startsAt.getTime()) {
    throw new Error("El fin no puede ser antes del inicio.");
  }
  const { data, error } = await getSupabaseClient()
    .from("events")
    .insert({
      workspace_id: wsId,
      project_id: input.projectId ?? null,
      title,
      description: input.description ?? "",
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
      all_day: input.allDay ?? false,
      location: input.location ?? "",
      color: input.color ?? "#1d9bf0",
      created_by: uid,
      attendees: input.attendees ?? [],
      reminder_minutes: input.reminderMinutes ?? [],
      recurrence: input.recurrence ?? null,
    })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error(eventErrorMessage(error));
  }
  return (data as { id: string }).id;
}

export type UpdateEventPatch = Partial<Omit<CreateEventInput, "startsAt" | "endsAt">> & {
  startsAt?: Date;
  endsAt?: Date;
};

export async function updateEvent(id: string, patch: UpdateEventPatch): Promise<void> {
  const data: Database["public"]["Tables"]["events"]["Update"] = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title === "") throw new Error("El evento no puede quedar sin título.");
    data["title"] = title;
  }
  if (patch.description !== undefined) data["description"] = patch.description;
  if (patch.startsAt !== undefined) data["starts_at"] = patch.startsAt.toISOString();
  if (patch.endsAt !== undefined) data["ends_at"] = patch.endsAt.toISOString();
  if (patch.allDay !== undefined) data["all_day"] = patch.allDay;
  if (patch.location !== undefined) data["location"] = patch.location;
  if (patch.color !== undefined) data["color"] = patch.color;
  if (patch.projectId !== undefined) data["project_id"] = patch.projectId;
  if (patch.attendees !== undefined) data["attendees"] = patch.attendees;
  if (patch.reminderMinutes !== undefined) data["reminder_minutes"] = patch.reminderMinutes;
  if (patch.recurrence !== undefined) data["recurrence"] = patch.recurrence;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("events").update(data).eq("id", id);
  if (error !== null) {
    throw new Error(eventErrorMessage(error));
  }
}

export async function deleteEvent(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("events").delete().eq("id", id);
  if (error !== null) {
    throw new Error(eventErrorMessage(error));
  }
}

// --- Recurrencia (expansión en cliente) ---------------------------------------

const MAX_OCCURRENCES = 120;

function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getDate();
  const out = new Date(date.getTime());
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  out.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return out;
}

function stepDate(date: Date, recurrence: EventRecurrence, step: number): Date {
  if (recurrence === "daily") {
    return new Date(date.getTime() + step * 86_400_000);
  }
  if (recurrence === "weekly") {
    return new Date(date.getTime() + step * 7 * 86_400_000);
  }
  return addMonthsClamped(date, step);
}

/** Expande un evento sobre [from, to] (ocurrencias ordenadas). */
export function expandRecurrence(
  event: EventItem,
  from: Date,
  to: Date,
): EventOccurrence[] {
  const start = event.startsAt.toDate();
  const end = event.endsAt.toDate();
  const duration = Math.max(0, end.getTime() - start.getTime());
  const out: EventOccurrence[] = [];
  const push = (s: Date): void => {
    const e = new Date(s.getTime() + duration);
    if (s.getTime() > to.getTime() || e.getTime() < from.getTime()) return;
    out.push({ ...event, startsAt: Timestamp.fromDate(s), endsAt: Timestamp.fromDate(e), occurrenceId: `${event.id}@${s.toISOString()}` });
  };
  if (event.recurrence === null) {
    push(start);
    return out;
  }
  for (let step = 0; step < MAX_OCCURRENCES; step += 1) {
    const s = stepDate(start, event.recurrence, step);
    if (s.getTime() > to.getTime()) break;
    push(s);
  }
  return out;
}

/** Ocurrencias de varios eventos sobre la ventana, ordenadas por inicio. */
export function occurrencesIn(
  events: EventItem[],
  from: Date,
  to: Date,
): EventOccurrence[] {
  const all = events.flatMap((event) => expandRecurrence(event, from, to));
  all.sort((a, b) => {
    const diff = a.startsAt.toMillis() - b.startsAt.toMillis();
    return diff !== 0 ? diff : a.occurrenceId.localeCompare(b.occurrenceId);
  });
  return all;
}
