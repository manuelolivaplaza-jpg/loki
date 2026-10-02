"use client";

/**
 * Tareas recurrentes y turnos rotativos sobre Supabase, capa de datos.
 *
 * Traduce el snake_case de Postgres a los tipos de `src/types/recurring.ts`.
 * Todo va con el JWT del usuario (la RLS es la puerta): cada miembro crea y
 * edita sus series, un admin todas, y un intercambio de turno solo lo
 * resuelven los dos involucrados (las RPCs `request_shift_swap` y
 * `resolve_shift_swap` lo comprueban otra vez en la base).
 *
 * Las ocurrencias son tareas normales (`tasks.series_id` +
 * `tasks.series_occurrence`): el kanban, Inicio y la búsqueda las leen sin
 * cambiar. Lo único que se escribe aquí son las series, los intercambios y la
 * rotación; las ocurrencias las genera la base por eventos
 * (`materialize_series_occurrences`, sin LLM).
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database, Json } from "@/types/supabase";
import type {
  NewSeriesInput,
  SeriesItem,
  SeriesPatch,
  SeriesPlanned,
  SeriesRule,
  SeriesScope,
  SeriesUsage,
  ShiftSwapItem,
  ShiftSwapStatus,
} from "@/types/recurring";

type SeriesRow = Database["public"]["Tables"]["task_series"]["Row"];
type SwapRow = Database["public"]["Tables"]["shift_swaps"]["Row"];
type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

export type Unsubscribe = () => void;

// Literales (no concatenados) para que `select()` siga inferiendo el tipo.
const SERIES_COLUMNS =
  "id, workspace_id, project_id, title, notes, priority, recurrence_kind, recurrence_interval, recurrence_unit, weekdays, month_day, month_week, month_weekday, start_date, time_of_day, timezone, remind_time, ends_on, rotation, rotation_index, rotation_skips, pauses, next_occurrence, last_occurrence, active, created_by, created_at, updated_at";

const SWAP_COLUMNS =
  "id, series_id, task_id, workspace_id, from_user_id, to_user_id, status, note, resolved_at, created_at";

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 42501 = RLS; P0001 = CHECK (regla incompleta o límite del espacio). */
function seriesError(error: unknown, fallback: string): Error {
  if (isRecord(error) && typeof error["code"] === "string") {
    if (error["code"] === "42501") {
      return new Error("No tienes permiso para eso en este espacio.");
    }
    if (error["code"] === "P0001" && typeof error["message"] === "string") {
      // El mensaje de la función va en "message"/"details" (PostgREST).
      const detail =
        typeof error["hint"] === "string" && error["hint"] !== ""
          ? error["hint"]
          : typeof error["details"] === "string"
            ? error["details"]
            : "";
      if (detail !== "") return new Error(detail);
    }
  }
  return new Error(fallback);
}

// --- Traducción -------------------------------------------------------------

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function smallints(raw: readonly number[] | null | undefined): number[] {
  return (raw ?? [])
    .map((value) => Math.trunc(numberOr(value, -1)))
    .filter((value) => value >= 0 && value <= 6);
}

function parseDateKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match === null ? "" : `${match[1]}-${match[2]}-${match[3]}`;
}

function parseTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const match = /^(\d{2}):(\d{2})/.exec(value.trim());
  return match === null ? fallback : `${match[1]}:${match[2]}`;
}

function pausesFrom(raw: unknown): SeriesItem["pauses"] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesItem["pauses"] = [];
  for (const entry of raw.slice(0, 30)) {
    if (!isRecord(entry)) continue;
    const from = parseDateKey(entry["from"]);
    if (from === "") continue;
    const to = parseDateKey(entry["to"]);
    out.push({
      from,
      to: to === "" ? from : to,
      reason: typeof entry["reason"] === "string" ? entry["reason"].slice(0, 120) : "",
    });
  }
  return out;
}

function skipsFrom(raw: unknown): SeriesItem["skips"] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesItem["skips"] = [];
  for (const entry of raw.slice(0, 60)) {
    if (!isRecord(entry)) continue;
    const userId = typeof entry["user_id"] === "string" ? entry["user_id"] : "";
    const from = parseDateKey(entry["from"]);
    if (userId === "" || from === "") continue;
    const to = parseDateKey(entry["to"]);
    out.push({
      userId,
      from,
      to: to === "" ? from : to,
      reason: typeof entry["reason"] === "string" ? entry["reason"].slice(0, 120) : "",
    });
  }
  return out;
}

function ruleOf(row: SeriesRow): SeriesRule {
  return {
    kind:
      row.recurrence_kind === "weekly" ||
      row.recurrence_kind === "monthly" ||
      row.recurrence_kind === "interval"
        ? row.recurrence_kind
        : "daily",
    interval: Math.min(60, Math.max(1, numberOr(row.recurrence_interval, 1))),
    unit: row.recurrence_unit === "days" ? "days" : "weeks",
    weekdays: smallints(row.weekdays),
    monthDay: row.month_day === null ? null : numberOr(row.month_day, 1),
    monthWeek: row.month_week === null ? null : numberOr(row.month_week, 1),
    monthWeekday: row.month_weekday === null ? null : numberOr(row.month_weekday, 1),
  };
}

function toSeries(row: SeriesRow): SeriesItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    notes: row.notes,
    priority: row.priority as SeriesItem["priority"],
    rule: ruleOf(row),
    startDate: parseDateKey(row.start_date),
    timeOfDay: parseTime(row.time_of_day, "09:00"),
    timezone: row.timezone.trim() === "" ? "America/Santiago" : row.timezone,
    remindTime: parseTime(row.remind_time, "09:00"),
    endsOn: row.ends_on === null ? null : parseDateKey(row.ends_on),
    rotation: row.rotation.filter((uid) => typeof uid === "string" && uid !== ""),
    rotationIndex: Math.max(0, numberOr(row.rotation_index, 0)),
    skips: skipsFrom(row.rotation_skips),
    pauses: pausesFrom(row.pauses),
    nextOccurrence: row.next_occurrence === null ? null : parseDateKey(row.next_occurrence),
    lastOccurrence: Math.max(0, numberOr(row.last_occurrence, 0)),
    active: row.active,
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function toSwap(row: SwapRow, selfUid: string, seriesTitle = ""): ShiftSwapItem {
  const pending = row.status === "pending";
  const direction: ShiftSwapItem["direction"] =
    !pending || row.from_user_id === row.to_user_id
      ? ""
      : row.to_user_id === selfUid
        ? "incoming"
        : "outgoing";
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status as ShiftSwapStatus,
    note: row.note,
    resolvedAt: toTimestampOrNull(row.resolved_at),
    createdAt: toTimestamp(row.created_at),
    direction,
  };
}

// --- Series -----------------------------------------------------------------

/** Series del espacio (activas primero, luego por título). */
export async function listSeries(wsId: string): Promise<SeriesItem[]> {
  if (wsId === "") return [];
  const { data, error } = await getSupabaseClient()
    .from("task_series")
    .select(SERIES_COLUMNS)
    .eq("workspace_id", wsId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(100);
  if (error !== null) {
    throw seriesError(error, "No se pudieron cargar las tareas recurrentes.");
  }
  return ((data ?? []) as SeriesRow[]).map(toSeries);
}

/** Series activas con rotación (las que aparecen en la vista Turnos). */
export async function listShiftSeries(wsId: string): Promise<SeriesItem[]> {
  const all = await listSeries(wsId);
  return all.filter((series) => series.active && series.rotation.length > 0);
}

/**
 * Crea una serie. La primera ocurrencia la arma el trigger
 * `task_series_after_insert` (por evento, no por sondeo).
 */
export async function createSeries(
  wsId: string,
  uid: string,
  input: NewSeriesInput,
): Promise<string> {
  const title = input.title.trim();
  if (title === "") throw new Error("Ponle un título a la tarea que se repite.");
  if (input.rule.kind === "weekly" && input.rule.weekdays.length === 0) {
    throw new Error("Elige al menos un día de la semana.");
  }
  if (input.rule.kind === "monthly" && input.rule.monthDay === null) {
    throw new Error("Elige el día del mes.");
  }
  const rule = input.rule;
  const row: Database["public"]["Tables"]["task_series"]["Insert"] = {
    workspace_id: wsId,
    project_id: input.projectId,
    title,
    notes: input.notes ?? "",
    priority: input.priority ?? "normal",
    recurrence_kind: rule.kind,
    recurrence_interval: Math.min(60, Math.max(1, Math.round(rule.interval))),
    recurrence_unit: rule.unit,
    weekdays: rule.weekdays,
    month_day: rule.monthDay,
    month_week: rule.monthWeek,
    month_weekday: rule.monthWeekday,
    start_date: input.startDate,
    time_of_day: input.timeOfDay,
    timezone: input.timezone ?? "America/Santiago",
    remind_time: input.remindTime ?? "09:00",
    ends_on: input.endsOn ?? null,
    rotation: input.rotation ?? [],
    rotation_index: 0,
    rotation_skips: [],
    pauses: (input.pauses ?? []).map((pause) => ({
      from: pause.from,
      to: pause.to === "" ? pause.from : pause.to,
      reason: pause.reason,
    })),
    active: true,
    created_by: uid,
  };
  const { data, error } = await getSupabaseClient()
    .from("task_series")
    .insert(row)
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw seriesError(error, "No se pudo crear la tarea que se repite.");
  }
  return (data as { id: string }).id;
}

/**
 * Edita por alcance ("solo esta" / "esta y las siguientes" / toda la serie).
 * Con `this` la ocurrencia se independiza y la serie no cambia: es la RPC
 * `edit_task_series`, que además rehace las ocurrencias que toquen.
 */
export async function editSeries(
  seriesId: string,
  scope: SeriesScope,
  patch: SeriesPatch,
  taskId: string | null = null,
): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc("edit_task_series", {
    p_series_id: seriesId,
    p_task_id: taskId,
    p_scope: scope,
    // El parche es un objeto plano de tipos primitivos (jsonb en la base).
    p_patch: patch as unknown as Json,
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo guardar la tarea que se repite.");
  }
  return typeof data === "number" ? data : 0;
}

/** Pausa o quita la pausa de días de la serie (parche simple de la RPC). */
export async function setSeriesPauses(
  seriesId: string,
  pauses: SeriesItem["pauses"],
): Promise<number> {
  return editSeries(seriesId, "all", {
    pauses: pauses.map((pause) => ({
      from: pause.from,
      to: pause.to === "" ? pause.from : pause.to,
      reason: pause.reason,
    })),
  });
}

export async function deleteSeries(
  seriesId: string,
  scope: SeriesScope = "all",
  taskId: string | null = null,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("delete_task_series", {
    p_series_id: seriesId,
    p_task_id: taskId,
    p_scope: scope,
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo borrar la tarea que se repite.");
  }
}

/** Uso del espacio (límite visible para el usuario, RPC `series_usage`). */
export async function getSeriesUsage(wsId: string): Promise<SeriesUsage | null> {
  if (wsId === "") return null;
  const { data, error } = await getSupabaseClient().rpc("series_usage", {
    p_workspace_id: wsId,
  });
  if (error !== null || !isRecord(data)) return null;
  return {
    active: numberOr(data["active"], 0),
    limit: numberOr(data["limit"], 50),
  };
}

// --- Ocurrencias (tareas normales de la serie) --------------------------------

const OCCURRENCE_COLUMNS =
  "id, project_id, workspace_id, title, due_at, status, assignee_ids, series_id, series_occurrence";

/** Tareas del espacio que nacieron de una serie (cualquier estado). */
export async function listSeriesOccurrences(
  wsId: string,
  fromISO: string,
  toISO: string,
): Promise<Database["public"]["Tables"]["tasks"]["Row"][]> {
  if (wsId === "") return [];
  const { data, error } = await getSupabaseClient()
    .from("tasks")
    .select(OCCURRENCE_COLUMNS)
    .eq("workspace_id", wsId)
    .not("series_id", "is", null)
    .gte("due_at", fromISO)
    .lt("due_at", toISO)
    .order("due_at", { ascending: true })
    .limit(200);
  if (error !== null) {
    throw seriesError(error, "No se pudieron cargar los turnos.");
  }
  return (data ?? []) as TaskRow[];
}

/** Turnos de una serie que me tocan un día local (bloque "Te toca hoy"). */
export async function listMyOccurrences(
  wsId: string,
  uid: string,
  dayKey: string,
): Promise<Database["public"]["Tables"]["tasks"]["Row"][]> {
  if (wsId === "" || uid === "") return [];
  // El rango es el día LOCAL del dispositivo, como el resto de la app.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (match === null) return [];
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const end = new Date(start.getTime() + 86_400_000);
  const { data, error } = await getSupabaseClient()
    .from("tasks")
    .select(OCCURRENCE_COLUMNS)
    .eq("workspace_id", wsId)
    .not("series_id", "is", null)
    .neq("status", "done")
    .gte("due_at", start.toISOString())
    .lt("due_at", end.toISOString())
    .order("due_at", { ascending: true })
    .limit(50);
  if (error !== null) {
    throw seriesError(error, "No se pudieron cargar tus turnos de hoy.");
  }
  const rows = ((data ?? []) as TaskRow[]).filter(
    (row) => row.series_id !== null && (row.assignee_ids ?? []).includes(uid),
  );
  return rows;
}

/** Escucha en vivo las tareas del espacio (Realtime) para refrescar la vista. */
export function listenSeriesTasks(
  wsId: string,
  cb: () => void,
): Unsubscribe {
  const supabase = getSupabaseClient();
  let channel: ReturnType<typeof supabase.channel> | null = null;
  try {
    channel = supabase.channel(`loki:series-tasks:${wsId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tasks", filter: `workspace_id=eq.${wsId}` },
      () => cb(),
    );
    channel.subscribe();
  } catch {
    return () => undefined;
  }
  return () => {
    if (channel !== null) void supabase.removeChannel(channel);
  };
}

// --- Turnos: intercambiar, saltar, reordenar ---------------------------------

/** Pedir el cambio ("¿me cambias el turno?") al siguiente de la rotación. */
export async function requestSwap(
  taskId: string,
  toUserId: string,
  note = "",
): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc("request_shift_swap", {
    p_task_id: taskId,
    p_to_user_id: toUserId,
    p_note: note,
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo pedir el cambio de turno.");
  }
  return typeof data === "string" ? data : "";
}

/** Aceptar o rechazar el intercambio (solo los dos involucrados). */
export async function resolveSwap(swapId: string, accept: boolean): Promise<void> {
  const { error } = await getSupabaseClient().rpc("resolve_shift_swap", {
    p_swap_id: swapId,
    p_accept: accept,
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo resolver el cambio de turno.");
  }
}

/**
 * Falta de un miembro en la rotación (vacaciones) en un rango: sus turnos
 * abiertos se pasan al siguiente. Devuelve cuántos se movieron.
 */
export async function skipShift(
  seriesId: string,
  userId: string,
  from: string,
  to: string,
  reason = "",
): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc("skip_shift", {
    p_series_id: seriesId,
    p_user_id: userId,
    p_from: from,
    p_to: to,
    p_reason: reason,
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo cambiar la rotación.");
  }
  return typeof data === "number" ? data : 0;
}

/** Nuevo orden de la rotación (mismas personas, otro orden). */
export async function reorderRotation(
  seriesId: string,
  order: readonly string[],
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("reorder_rotation", {
    p_series_id: seriesId,
    p_order: [...order],
  });
  if (error !== null) {
    throw seriesError(error, "No se pudo cambiar el orden de los turnos.");
  }
}

/** Intercambios donde participo (pendientes primero). */
export async function listSwaps(wsId: string, uid: string): Promise<ShiftSwapItem[]> {
  if (wsId === "" || uid === "") return [];
  const { data, error } = await getSupabaseClient()
    .from("shift_swaps")
    .select(SWAP_COLUMNS)
    .eq("workspace_id", wsId)
    .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error !== null) {
    throw seriesError(error, "No se pudieron cargar los cambios de turno.");
  }
  const rows = (data ?? []) as SwapRow[];
  if (rows.length === 0) return [];
  // Título de la serie para poder listarlo sin otro clic.
  const seriesIds = [...new Set(rows.map((row) => row.series_id))];
  const seriesRes = await getSupabaseClient()
    .from("task_series")
    .select("id, title")
    .in("id", seriesIds);
  const titles = new Map<string, string>();
  for (const row of (seriesRes.data ?? []) as { id: string; title: string }[]) {
    titles.set(row.id, row.title);
  }
  return rows.map((row) => toSwap(row, uid, titles.get(row.series_id) ?? "Turno"));
}

/** Avisa en vivo de cambios en las series y los intercambios del espacio. */
export function listenSeries(
  wsId: string,
  cb: () => void,
): Unsubscribe {
  const supabase = getSupabaseClient();
  let channel: ReturnType<typeof supabase.channel> | null = null;
  try {
    channel = supabase.channel(`loki:series:${wsId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "task_series", filter: `workspace_id=eq.${wsId}` },
      () => cb(),
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "shift_swaps", filter: `workspace_id=eq.${wsId}` },
      () => cb(),
    );
    channel.subscribe();
  } catch {
    return () => undefined;
  }
  return () => {
    if (channel !== null) void supabase.removeChannel(channel);
  };
}

// --- Utilidades para las pantallas -------------------------------------------

/** Ocurrencias previstas de varias series, mezcladas y ordenadas por fecha. */
export function mergePlanned(
  lists: readonly SeriesPlanned[][],
): SeriesPlanned[] {
  const out = lists.flat().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.seriesId.localeCompare(b.seriesId);
  });
  return out;
}