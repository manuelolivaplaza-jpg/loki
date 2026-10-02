"use client";

/**
 * Selector de recurrencia compacto: chips L M M J V S D (45 px, usable con el
 * pulgar) para el semanal, selector de tipo (diario / semanal / mensual /
 * cada N) y, en mensual, el día del mes o el "primer lunes". La fecha de
 * término es opcional.
 *
 * En escritorio el mismo bloque se puede abrir en un popover junto al campo de
 * fecha (`collapsible`); en móvil se muestra en línea, que con estos chips ya
 * cabe en 360 px.
 */

import * as React from "react";
import { CalendarClock, ChevronDown } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { describeRule } from "@/lib/recurring/recurrence";
import type { SeriesKind, SeriesRule } from "@/types/recurring";
import { MONTH_WEEK_LABELS, WEEKDAY_CHIPS, WEEKDAY_NAMES } from "@/types/recurring";
import { cn } from "@/lib/utils";

const KINDS: readonly { value: SeriesKind; label: string }[] = [
  { value: "daily", label: "Diario" },
  { value: "weekly", label: "Semanal" },
  { value: "monthly", label: "Mensual" },
  { value: "interval", label: "Cada N" },
];

function toggleWeekday(current: number[], day: number): number[] {
  return current.includes(day)
    ? current.filter((value) => value !== day)
    : [...current, day];
}

export function RecurrencePicker({
  rule,
  startDate,
  endsOn,
  onChange,
  onStartDateChange,
  onEndsOnChange,
  collapsible = false,
}: {
  rule: SeriesRule;
  startDate: string;
  endsOn: string | null;
  onChange: (rule: SeriesRule) => void;
  onStartDateChange: (value: string) => void;
  onEndsOnChange: (value: string | null) => void;
  /** En escritorio: plegado detrás de un botón junto al campo de fecha. */
  collapsible?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(!collapsible);
  // En escritorio (≥1024 px) el bloque arranca plegado, como un popover junto
  // al campo de fecha; en móvil se ve en línea, que con estos chips ya cabe.
  const [desktop, setDesktop] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const apply = (): void => setDesktop(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, []);
  const folded = collapsible === true || desktop;

  const body = (
    <div className="flex flex-col gap-3">
      <div>
        <span className={labelClassName}>Se repite</span>
        <div
          role="radiogroup"
          aria-label="Frecuencia de la repetición"
          className="mt-1 flex rounded-full bg-surface-soft p-1"
        >
          {KINDS.map((kind) => {
            const selected = rule.kind === kind.value;
            return (
              <button
                key={kind.value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={kind.label}
                onClick={() =>
                  onChange({
                    ...rule,
                    kind: kind.value,
                    // Al cambiar de tipo, deja algo coherente seleccionado.
                    weekdays:
                      kind.value === "weekly" && rule.weekdays.length === 0
                        ? [todayWeekday()]
                        : rule.weekdays,
                    monthDay: kind.value === "monthly" && rule.monthDay === null ? todayDayOfMonth() : rule.monthDay,
                    monthWeek:
                      kind.value === "monthly" && rule.monthDay === null ? 1 : rule.monthWeek,
                    monthWeekday:
                      kind.value === "monthly" && rule.monthDay === null ? 1 : rule.monthWeekday,
                  })
                }
                className={cn(
                  "h-10 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                  selected
                    ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                    : "text-muted-foreground",
                )}
              >
                {kind.label}
              </button>
            );
          })}
        </div>
      </div>

      {rule.kind === "weekly" ? (
        <div>
          <span className={labelClassName}>Días</span>
          <div role="group" aria-label="Días de la semana" className="mt-1 flex gap-1.5">
            {WEEKDAY_CHIPS.map((chip) => {
              const selected = rule.weekdays.includes(chip.value);
              return (
                <button
                  key={chip.value}
                  type="button"
                  aria-pressed={selected}
                  aria-label={WEEKDAY_NAMES[chip.value] ?? chip.label}
                  onClick={() => onChange({ ...rule, weekdays: toggleWeekday(rule.weekdays, chip.value) })}
                  className={cn(
                    "h-11 w-11 rounded-full text-body font-semibold outline-none interactive",
                    selected
                      ? "bg-foreground text-background dark:bg-white dark:text-black"
                      : "bg-surface-soft text-muted-foreground",
                  )}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {rule.kind === "interval" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="series-interval" className={labelClassName}>
              Cada
            </label>
            <input
              id="series-interval"
              type="number"
              min={1}
              max={60}
              inputMode="numeric"
              value={rule.interval}
              onChange={(event) =>
                onChange({
                  ...rule,
                  interval: Math.min(60, Math.max(1, Number(event.target.value) || 1)),
                })
              }
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="series-unit" className={labelClassName}>
              Unidad
            </label>
            <select
              id="series-unit"
              value={rule.unit}
              onChange={(event) =>
                onChange({ ...rule, unit: event.target.value === "days" ? "days" : "weeks" })
              }
              className={inputClassName}
            >
              <option value="days">días</option>
              <option value="weeks">semanas</option>
            </select>
          </div>
        </div>
      ) : null}

      {rule.kind === "monthly" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="series-month-mode" className={labelClassName}>
              Cómo
            </label>
            <select
              id="series-month-mode"
              value={rule.monthDay === null ? "weekday" : "day"}
              onChange={(event) =>
                onChange({
                  ...rule,
                  monthDay: event.target.value === "day" ? todayDayOfMonth() : null,
                  monthWeek: event.target.value === "day" ? null : 1,
                  monthWeekday: event.target.value === "day" ? null : 1,
                })
              }
              className={inputClassName}
            >
              <option value="day">Día del mes</option>
              <option value="weekday">Día de la semana</option>
            </select>
          </div>
          {rule.monthDay === null ? (
            <>
              <div>
                <label htmlFor="series-month-week" className={labelClassName}>
                  Cuál
                </label>
                <select
                  id="series-month-week"
                  value={rule.monthWeek ?? 1}
                  onChange={(event) =>
                    onChange({ ...rule, monthWeek: Number(event.target.value) || 1 })
                  }
                  className={inputClassName}
                >
                  {MONTH_WEEK_LABELS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="series-month-weekday" className={labelClassName}>
                  Día
                </label>
                <select
                  id="series-month-weekday"
                  value={rule.monthWeekday ?? 1}
                  onChange={(event) =>
                    onChange({ ...rule, monthWeekday: Number(event.target.value) || 0 })
                  }
                  className={inputClassName}
                >
                  {WEEKDAY_CHIPS.map((chip) => (
                    <option key={chip.value} value={chip.value}>
                      {WEEKDAY_NAMES[chip.value]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label htmlFor="series-month-day" className={labelClassName}>
                Día
              </label>
              <input
                id="series-month-day"
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                value={rule.monthDay}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    monthDay: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                  })
                }
                className={inputClassName}
              />
            </div>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="series-start" className={labelClassName}>
            Primera vez
          </label>
          <input
            id="series-start"
            type="date"
            value={startDate}
            onChange={(event) => onStartDateChange(event.target.value)}
            className={inputClassName}
          />
        </div>
        <div>
          <label htmlFor="series-ends" className={labelClassName}>
            Termina (opcional)
          </label>
          <input
            id="series-ends"
            type="date"
            value={endsOn ?? ""}
            min={startDate}
            onChange={(event) =>
              onEndsOnChange(event.target.value === "" ? null : event.target.value)
            }
            className={inputClassName}
          />
        </div>
      </div>

      <p className="text-meta text-muted-foreground">{describeRule(rule)}</p>
    </div>
  );

  if (!folded) return body;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 rounded-sm px-1 text-body-sm font-medium text-foreground outline-none interactive"
      >
        <Icon icon={CalendarClock} size={20} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">
          {describeRule(rule)}
          {endsOn !== null ? " · con fecha de término" : ""}
        </span>
        <Icon
          icon={ChevronDown}
          size={20}
          className={cn("shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "")}
        />
      </button>
      {open ? body : null}
    </div>
  );
}

function todayWeekday(): number {
  return new Date().getDay();
}

function todayDayOfMonth(): number {
  return new Date().getDate();
}