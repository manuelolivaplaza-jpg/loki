/**
 * Regla de recurrencia en el cliente: MISMA lógica que las funciones
 * `series_date_matches`, `series_in_pause` y `series_pick_rotation` de la
 * migración `20261017000000_tareas_recurrentes_turnos.sql` (espejo, como se
 * hace con la recurrencia de eventos). Todo en `date` local: así el horario de
 * verano de Chile no se cuela en el cálculo de la fecha (la hora la aplica
 * Postgres al convertir a `timestamptz` con la zona de la serie).
 *
 * Sin dependencias y sin `any`: la usan la vista Turnos, la previsualización
 * de la hoja de serie y el planificador.
 */

import type {
  SeriesItem,
  SeriesPause,
  SeriesPlanned,
  SeriesRule,
  SeriesSkip,
} from "@/types/recurring";
import { MONTH_WEEK_LABELS, WEEKDAY_NAMES } from "@/types/recurring";

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" de una fecha local (sin pasar por UTC: no queremos corrimiento). */
export function toDateKey(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Fecha local desde "YYYY-MM-DD" (a medianoche local). */
export function fromDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** ¿La fecha cumple la regla? (mismo criterio que `series_date_matches`). */
export function seriesDateMatches(
  rule: SeriesRule,
  startDate: Date,
  date: Date,
): boolean {
  if (rule.kind === "daily") {
    return date.getTime() >= startDate.getTime();
  }
  if (date.getTime() < startDate.getTime()) return false;
  if (rule.kind === "interval") {
    const step = Math.max(1, rule.interval) * (rule.unit === "weeks" ? 7 : 1);
    const days = Math.round(
      (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
        new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime()) /
        DAY_MS,
    );
    return ((days % step) + step) % step === 0;
  }
  if (rule.kind === "weekly") {
    return rule.weekdays.includes(date.getDay());
  }
  // Mensual
  const day = date.getDate();
  const last = daysInMonth(date);
  if (rule.monthDay !== null) {
    return day === Math.min(rule.monthDay, last);
  }
  if (rule.monthWeek === null || rule.monthWeekday === null) return false;
  if (date.getDay() !== rule.monthWeekday) return false;
  if (rule.monthWeek >= 5) return day + 7 > last;
  return Math.floor((day - 1) / 7) + 1 === rule.monthWeek;
}

/** ¿La fecha cae en una pausa? (mismo criterio que `series_in_pause`). */
export function isPaused(pauses: readonly SeriesPause[], date: Date): boolean {
  const key = toDateKey(date);
  return pauses.some((pause) => {
    const from = pause.from.trim();
    const to = (pause.to.trim() === "" ? from : pause.to.trim());
    if (from === "") return false;
    return key >= from && key <= to;
  });
}

/** ¿Alguien está de vacaciones ese día? (mismo criterio que `series_is_skipped`). */
export function isSkipped(
  skips: readonly SeriesSkip[],
  userId: string,
  date: Date,
): boolean {
  const key = toDateKey(date);
  return skips.some((skip) => {
    if (skip.userId !== userId) return false;
    const from = skip.from.trim();
    const to = skip.to.trim() === "" ? from : skip.to.trim();
    if (from === "") return false;
    return key >= from && key <= to;
  });
}

/**
 * Siguiente fecha que cumple la regla después de `after` (sin contar), saltando
 * pausas y sin pasar de `endsOn`. Es el espejo de `series_next_date`.
 */
export function nextOccurrenceDate(
  series: Pick<
    SeriesItem,
    "rule" | "startDate" | "pauses" | "endsOn" | "timezone"
  >,
  after: Date | null,
  today: Date,
  maxDays = 800,
): Date | null {
  const start = fromDateKey(series.startDate) ?? today;
  const ends = series.endsOn === null ? null : fromDateKey(series.endsOn);
  let date = after === null ? start : addDays(after, 1);
  if (after === null && date.getTime() < today.getTime()) {
    date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }
  for (let step = 0; step < maxDays; step += 1) {
    if (ends !== null && date.getTime() > ends.getTime()) return null;
    if (
      seriesDateMatches(series.rule, start, date) &&
      !isPaused(series.pauses, date)
    ) {
      return date;
    }
    date = addDays(date, 1);
  }
  return null;
}

/**
 * Quién de la rotación toca en esa fecha, a partir de `index` (mismo criterio
 * que `series_pick_rotation`). Devuelve el uid elegido y el índice que queda
 * para la siguiente (no avanza si el padrón entero está de vacaciones).
 */
export function rotationAt(
  rotation: readonly string[],
  index: number,
  skips: readonly SeriesSkip[],
  date: Date,
  isMember: (uid: string) => boolean,
): { uid: string; nextIndex: number } {
  const n = rotation.length;
  if (n === 0) return { uid: "", nextIndex: Math.max(0, index) };
  for (let k = 0; k < n; k += 1) {
    // `index` es base 0 sobre la lista: con 0 le toca a la primera persona.
    const pos = ((index + k) % n + n) % n;
    const candidate = rotation[pos] ?? "";
    if (candidate === "") continue;
    if (isSkipped(skips, candidate, date)) continue;
    if (!isMember(candidate)) continue;
    return { uid: candidate, nextIndex: (pos + 1) % n };
  }
  return { uid: "", nextIndex: Math.max(0, index) };
}

/**
 * Las próximas ocurrencias previstas de una serie (con su responsable), para
 * la vista Turnos y la previsualización. Máximo 60 (unos dos meses).
 */
export function plannedOccurrences(
  series: SeriesItem,
  count: number,
  from: Date,
  isMember: (uid: string) => boolean = () => true,
): SeriesPlanned[] {
  const out: SeriesPlanned[] = [];
  if (!series.active) return out;
  let cursor: Date | null = from;
  let index = series.rotationIndex;
  let occurrence = series.lastOccurrence;
  for (let step = 0; step < Math.min(count, 60); step += 1) {
    const date = nextOccurrenceDate(series, cursor, from);
    if (date === null) break;
    const pick = rotationAt(series.rotation, index, series.skips, date, isMember);
    occurrence += 1;
    out.push({
      seriesId: series.id,
      occurrence,
      date: toDateKey(date),
      assigneeId: pick.uid,
      taskId: null,
    });
    index = pick.nextIndex;
    cursor = date;
  }
  return out;
}

/** "cada martes", "el primer lunes de cada mes", "cada 2 semanas"… */
export function describeRule(rule: SeriesRule): string {
  if (rule.kind === "daily") return "todos los días";
  if (rule.kind === "interval") {
    const unit = rule.unit === "weeks" ? "semanas" : "días";
    return rule.interval === 1
      ? `cada ${unit.slice(0, -1)}`
      : `cada ${rule.interval} ${unit}`;
  }
  if (rule.kind === "weekly") {
    const days = [...rule.weekdays]
      .filter((day) => day >= 0 && day <= 6)
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((day) => WEEKDAY_NAMES[day] ?? "");
    if (days.length === 0) return "sin días";
    if (days.length === 7) return "todos los días";
    return `cada ${days.join(", ")}`;
  }
  if (rule.monthDay !== null) return `el ${rule.monthDay} de cada mes`;
  if (rule.monthWeek !== null && rule.monthWeekday !== null) {
    const week = MONTH_WEEK_LABELS.find((entry) => entry.value === rule.monthWeek);
    const day = WEEKDAY_NAMES[rule.monthWeekday] ?? "";
    return `el ${week?.label ?? "primero"} ${day} de cada mes`;
  }
  return "sin regla";
}

/** "Sofi, Tomás, tú" con la rotación en orden (para la hoja y la lista). */
export function describeRotation(
  rotation: readonly string[],
  nameOf: (uid: string) => string,
  selfUid: string,
): string {
  const names = rotation
    .filter((uid) => uid !== "")
    .map((uid) => (uid === selfUid ? "tú" : nameOf(uid)));
  return names.join(", ");
}