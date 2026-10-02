import type { Timestamp } from "@/lib/timestamp";

/**
 * Tareas recurrentes y turnos rotativos (`task_series`, `shift_swaps`).
 *
 * Una serie es una PLANTILLA: cada ocurrencia es una tarea normal en `tasks`
 * (con `seriesId` y `seriesOccurrence`), así que el kanban, Inicio, la búsqueda
 * y los recordatorios no cambian. La rotación reparte las ocurrencias entre los
 * miembros del espacio.
 *
 * Los nombres van en camelCase; el adaptador `src/lib/data/series.ts` traduce
 * el snake_case de Postgres.
 */

/** Reglas acotadas (a propósito: nada de RRULE completo). */
export type SeriesKind = "daily" | "weekly" | "monthly" | "interval";

export interface SeriesRule {
  kind: SeriesKind;
  /** kind 'interval': cada N (1-60). */
  interval: number;
  /** kind 'interval': la unidad del intervalo. */
  unit: "days" | "weeks";
  /** kind 'weekly': días de la semana (0 domingo … 6 sábado). */
  weekdays: number[];
  /** kind 'monthly': día del mes (1-31; en meses cortos, el último día). */
  monthDay: number | null;
  /** kind 'monthly': semana 1-4 o 5 = el último (p. ej. "el último viernes"). */
  monthWeek: number | null;
  /** kind 'monthly': día 0-6 del "primer lunes". */
  monthWeekday: number | null;
}

/** Pausa o excepción de días: la serie no ocurre en ese rango. */
export interface SeriesPause {
  from: string;
  to: string;
  reason: string;
}

/** Falta de un miembro en la rotación (vacaciones) en un rango de fechas. */
export interface SeriesSkip {
  userId: string;
  from: string;
  to: string;
  reason: string;
}

export interface SeriesItem {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  notes: string;
  priority: "low" | "normal" | "high";
  rule: SeriesRule;
  /** "YYYY-MM-DD" de la primera ocurrencia posible. */
  startDate: string;
  /** "HH:MM" local de la ocurrencia. */
  timeOfDay: string;
  /** Zona IANA (default America/Santiago). */
  timezone: string;
  /** "HH:MM" del aviso (día antes y el mismo día). */
  remindTime: string;
  /** Fecha de término opcional ("YYYY-MM-DD"). */
  endsOn: string | null;
  rotation: string[];
  rotationIndex: number;
  skips: SeriesSkip[];
  pauses: SeriesPause[];
  /** Próxima fecha por generar (la calcula la base). */
  nextOccurrence: string | null;
  lastOccurrence: number;
  active: boolean;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Una ocurrencia ya materializada (es una tarea normal). */
export interface SeriesOccurrence {
  seriesId: string;
  seriesTitle: string;
  occurrence: number;
  taskId: string;
  projectId: string;
  title: string;
  /** Fecha local de la ocurrencia ("YYYY-MM-DD"). */
  date: string;
  dueAt: Timestamp | null;
  status: "todo" | "doing" | "done";
  /** Responsable del turno (o "" si la serie no tiene rotación). */
  assigneeId: string;
  done: boolean;
}

/** Ocurrencia prevista (aún no es una tarea): solo para la vista Turnos. */
export interface SeriesPlanned {
  seriesId: string;
  occurrence: number;
  date: string;
  assigneeId: string;
  /** Ya existe como tarea (viene de la base). */
  taskId: string | null;
}

export type ShiftSwapStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export interface ShiftSwapItem {
  id: string;
  seriesId: string;
  seriesTitle: string;
  taskId: string | null;
  workspaceId: string;
  fromUserId: string;
  toUserId: string;
  status: ShiftSwapStatus;
  note: string;
  resolvedAt: Timestamp | null;
  createdAt: Timestamp;
  /** "Me lo pidieron" / "Lo pedí yo" / "" (ya resuelto, solo histórico). */
  direction: "incoming" | "outgoing" | "";
}

export type SeriesScope = "this" | "following" | "all";

export interface NewSeriesInput {
  projectId: string;
  title: string;
  notes?: string;
  priority?: SeriesItem["priority"];
  rule: SeriesRule;
  /** "YYYY-MM-DD" de la primera ocurrencia. */
  startDate: string;
  /** "HH:MM" local. */
  timeOfDay: string;
  /** "HH:MM" del aviso (default "09:00"). */
  remindTime?: string;
  timezone?: string;
  endsOn?: string | null;
  /** Rotación inicial (vacía = sin turnos). */
  rotation?: string[];
  pauses?: SeriesPause[];
}

/** Parche que viaja a la RPC `edit_task_series` (mismas claves, jsonb). */
export interface SeriesPatch {
  title?: string;
  notes?: string;
  priority?: SeriesItem["priority"];
  recurrence_kind?: SeriesRule["kind"];
  recurrence_interval?: number;
  recurrence_unit?: SeriesRule["unit"];
  weekdays?: number[];
  month_day?: number | null;
  month_week?: number | null;
  month_weekday?: number | null;
  start_date?: string;
  timeOfDay?: string;
  remindTime?: string;
  timezone?: string;
  endsOn?: string | null;
  pauses?: SeriesPause[];
  rotation?: string[];
  active?: boolean;
}

/** Uso del espacio para el aviso de límite (RPC `series_usage`). */
export interface SeriesUsage {
  active: number;
  limit: number;
}

export const WEEKDAY_LETTERS = ["D", "L", "M", "M", "J", "V", "S"] as const;

/** Etiquetas de día en orden de lunes a domingo (para los chips L M M J V S D). */
export const WEEKDAY_CHIPS: readonly { value: number; label: string }[] = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "M" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
];

export const WEEKDAY_NAMES: readonly string[] = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

export const MONTH_WEEK_LABELS: readonly { value: number; label: string }[] = [
  { value: 1, label: "primero" },
  { value: 2, label: "segundo" },
  { value: 3, label: "tercero" },
  { value: 4, label: "cuarto" },
  { value: 5, label: "último" },
];

export const DEFAULT_SERIES_RULE: SeriesRule = {
  kind: "weekly",
  interval: 1,
  unit: "weeks",
  weekdays: [2],
  monthDay: null,
  monthWeek: null,
  monthWeekday: null,
};