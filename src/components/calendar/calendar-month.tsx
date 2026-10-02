"use client";

import * as React from "react";
import type { EventItem, EventOccurrence } from "@/types/organizer";
import { cn } from "@/lib/utils";

const WEEKDAYS_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const WEEKDAYS_LETTER = ["L", "M", "M", "J", "V", "S", "D"];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function monthName(date: Date): string {
  return new Intl.DateTimeFormat("es", { month: "long" }).format(date);
}

/**
 * Marca discreta de turno/tarea recurrente en la celda del mes: no compite con
 * los eventos (va punteada y sin color de serie) y al tocarla abre la tarea.
 */
export type ShiftMark = {
  taskId: string;
  projectId: string;
  title: string;
  assigneeId: string;
};

/** Clave "año-mes-día" local (para agrupar por día sin pasar por UTC). */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function CalendarMonth({
  anchor,
  occurrences,
  shifts = [],
  onSelectDay,
  onSelectEvent,
  onSelectShift,
}: {
  anchor: Date;
  occurrences: EventOccurrence[];
  /** Ocurrencias de series (turnos) de la ventana visible. */
  shifts?: readonly { date: Date; mark: ShiftMark }[];
  onSelectDay: (day: Date) => void;
  onSelectEvent: (event: EventItem) => void;
  onSelectShift?: (mark: ShiftMark) => void;
}): React.JSX.Element {
  const today = React.useMemo(() => new Date(), []);
  const cells = React.useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getTime());
    start.setDate(start.getDate() - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start.getTime());
      day.setDate(day.getDate() + index);
      return day;
    });
  }, [anchor]);
  const byDay = React.useMemo(() => {
    const map = new Map<string, EventOccurrence[]>();
    for (const occurrence of occurrences) {
      const day = occurrence.startsAt.toDate();
      const key = localDayKey(day);
      const list = map.get(key) ?? [];
      list.push(occurrence);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
    }
    return map;
  }, [occurrences]);

  const shiftsByDay = React.useMemo(() => {
    const map = new Map<string, ShiftMark[]>();
    for (const entry of shifts) {
      const key = localDayKey(entry.date);
      const list = map.get(key) ?? [];
      list.push(entry.mark);
      map.set(key, list);
    }
    return map;
  }, [shifts]);

  return (
    <div role="grid" aria-label="Mes" className="overflow-hidden rounded-2xl border border-divider bg-background">
      <div aria-hidden="true" className="grid grid-cols-7 border-b border-divider bg-surface-soft/60">
        {WEEKDAYS_SHORT.map((name, index) => (
          <span
            key={name}
            className="py-2 text-center text-meta font-semibold uppercase tracking-wide text-muted-foreground"
          >
            <span className="hidden md:inline">{name}</span>
            <span className="md:hidden">{WEEKDAYS_LETTER[index]}</span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, cellIndex) => {
          const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const all = byDay.get(key) ?? [];
          const marks = shiftsByDay.get(key) ?? [];
          const shown = all.slice(0, 3);
          const extra = all.length - shown.length;
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = sameDay(day, today);
          const isLastRow = cellIndex >= 35;
          const isLastCol = cellIndex % 7 === 6;
          return (
            <div
              key={key}
              className={cn(
                "flex min-h-[76px] flex-col items-stretch gap-1 p-1.5 md:min-h-[104px] md:p-2",
                !isLastRow && "border-b border-divider",
                !isLastCol && "border-r border-divider",
                isToday ? "bg-accent/[0.07]" : "bg-background",
                !inMonth && "opacity-50",
              )}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label={`Crear el ${day.getDate()} de ${monthName(day)}`}
                  onClick={() => onSelectDay(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-body-sm outline-none interactive",
                    isToday
                      ? "bg-foreground font-bold text-background dark:bg-white dark:text-black"
                      : "font-medium text-foreground",
                    !inMonth && "text-muted-foreground",
                  )}
                >
                  {day.getDate()}
                </button>
                {all.length > 2 ? (
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-surface-soft px-1.5 text-meta font-semibold leading-4 text-muted-foreground"
                  >
                    {all.length}
                  </span>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-col gap-1">
                {shown.map((occurrence) => (
                  <button
                    key={occurrence.occurrenceId}
                    type="button"
                    aria-label={`${occurrence.title}, ${new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(occurrence.startsAt.toDate())}`}
                    onClick={() => onSelectEvent(occurrence)}
                    className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left outline-none interactive"
                    style={{ backgroundColor: `${occurrence.color}1f` }}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: occurrence.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-meta font-medium leading-4 text-foreground">
                      {occurrence.title}
                    </span>
                    <span className="hidden shrink-0 text-meta tabular-nums leading-4 text-muted-foreground md:inline">
                      {new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(occurrence.startsAt.toDate())}
                    </span>
                  </button>
                ))}
                {extra > 0 ? (
                  <span className="px-1.5 text-left text-meta font-medium leading-4 text-accent">
                    +{extra} más
                  </span>
                ) : null}
                {/* Turnos y tareas recurrentes: marcas discretas debajo. */}
                {marks.slice(0, 2).map((mark) => (
                  <button
                    key={mark.taskId}
                    type="button"
                    aria-label={`Turno: ${mark.title}`}
                    onClick={() => onSelectShift?.(mark)}
                    className="flex min-w-0 items-center gap-1 rounded-md border border-dashed border-divider px-1.5 py-0.5 text-left outline-none interactive"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                    <span className="min-w-0 flex-1 truncate text-meta leading-4 text-muted-foreground">
                      {mark.title}
                    </span>
                  </button>
                ))}
                {marks.length > 2 ? (
                  <span className="px-1.5 text-left text-meta leading-4 text-muted-foreground">
                    +{marks.length - 2} turnos
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
