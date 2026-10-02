"use client";

import * as React from "react";
import { MapPin } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { formatHour } from "@/lib/chat/format";
import { SECTIONS } from "@/components/shell/sections";
import type { EventItem, EventOccurrence } from "@/types/organizer";
import type { ShiftMark } from "@/components/calendar/calendar-month";
import { cn } from "@/lib/utils";

function dayKey(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayMeta(date: Date, today: Date): { badge: string; label: string; isToday: boolean } {
  const diff = Math.round((dayKey(date) - dayKey(today)) / 86_400_000);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "short" })
    .format(date)
    .replace(".", "");
  const month = new Intl.DateTimeFormat("es", { month: "short" })
    .format(date)
    .replace(".", "");
  if (diff === 0) return { badge: "Hoy", label: `${date.getDate()} ${month}`, isToday: true };
  if (diff === 1) return { badge: "Mañana", label: `${date.getDate()} ${month}`, isToday: false };
  const name = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return { badge: name, label: `${date.getDate()} ${month}`, isToday: false };
}

export function CalendarAgenda({
  occurrences,
  shifts = [],
  onSelectEvent,
  onSelectShift,
}: {
  occurrences: EventOccurrence[];
  /** Turnos y tareas recurrentes de la ventana (marcas discretas). */
  shifts?: readonly { date: Date; mark: ShiftMark }[];
  onSelectEvent: (event: EventItem) => void;
  onSelectShift?: (mark: ShiftMark) => void;
}): React.JSX.Element {
  const today = React.useMemo(() => new Date(), []);
  const groups = React.useMemo(() => {
    const map = new Map<string, { day: Date; items: EventOccurrence[] }>();
    for (const occurrence of occurrences) {
      const start = occurrence.startsAt.toDate();
      const key = `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
      const entry = map.get(key) ?? {
        day: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
        items: [],
      };
      entry.items.push(occurrence);
      map.set(key, entry);
    }
    const sorted = [...map.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
    for (const group of sorted) {
      group.items.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
    }
    return sorted;
  }, [occurrences]);

  const marksByDay = React.useMemo(() => {
    const map = new Map<string, ShiftMark[]>();
    for (const entry of shifts) {
      const key = `${entry.date.getFullYear()}-${entry.date.getMonth()}-${entry.date.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(entry.mark);
      map.set(key, list);
    }
    return map;
  }, [shifts]);

  const markedDays = React.useMemo(
    () =>
      [...marksByDay.entries()]
        .map(([key, marks]) => ({
          day: new Date(
            Number(key.split("-")[0]),
            Number(key.split("-")[1]),
            Number(key.split("-")[2]),
          ),
          marks,
        }))
        .sort((a, b) => a.day.getTime() - b.day.getTime()),
    [marksByDay],
  );

  if (groups.length === 0 && markedDays.length === 0) {
    const section = SECTIONS.calendario;
    return (
      <EmptyState
        icon={section.icon}
        title={section.emptyTitle}
        description={section.emptyDescription}
      />
    );
  }

  return (
    <ol className="flex flex-col gap-5">
      {groups.map(({ day, items }) => {
        const meta = dayMeta(day, today);
        return (
          <li key={day.toISOString()}>
            <section aria-label={`${meta.badge}, ${meta.label}`}>
              <div className="flex items-center gap-3 px-1 pb-2">
                <span
                  className={cn(
                    "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-2xl leading-none",
                    meta.isToday
                      ? "bg-foreground text-background dark:bg-white dark:text-black"
                      : "bg-surface-soft text-foreground",
                  )}
                >
                  <span className="text-body font-bold leading-5">{day.getDate()}</span>
                  <span className="text-meta capitalize leading-4 opacity-70">
                    {new Intl.DateTimeFormat("es", { month: "short" }).format(day).replace(".", "")}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-body font-semibold leading-6",
                      meta.isToday ? "text-foreground" : "text-foreground",
                    )}
                  >
                    {meta.badge}
                  </p>
                  <p className="text-meta leading-4 text-muted-foreground">
                    {items.length === 1 ? "1 evento" : `${items.length} eventos`}
                  </p>
                </div>
              </div>
              <ol className="relative ml-[22px] flex flex-col gap-2 border-l border-divider pl-4">
                {items.map((occurrence) => (
                  <li key={occurrence.occurrenceId} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-background"
                      style={{ backgroundColor: occurrence.color }}
                    />
                    <button
                      type="button"
                      onClick={() => onSelectEvent(occurrence)}
                      aria-label={`${occurrence.title}, ${occurrence.allDay ? "todo el día" : formatHour(occurrence.startsAt)}`}
                      className="flex w-full items-center gap-3 rounded-2xl bg-surface-soft px-4 py-3 text-left outline-none interactive"
                    >
                      <span className="w-14 shrink-0 text-body-sm font-semibold tabular-nums text-foreground">
                        {occurrence.allDay ? "Todo el día" : formatHour(occurrence.startsAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-semibold leading-6 text-foreground">
                          {occurrence.title}
                        </span>
                        {occurrence.location !== "" ? (
                          <span className="flex items-center gap-1 text-meta leading-5 text-muted-foreground">
                            <Icon icon={MapPin} size={20} />
                            <span className="truncate">{occurrence.location}</span>
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          </li>
        );
      })}
      {/* Turnos: marcas discretas por día (siguen el motor de la serie). */}
      {markedDays.map(({ day, marks }) => {
        const meta = dayMeta(day, today);
        return (
          <li key={`turnos-${day.toISOString()}`}>
            <section aria-label={`Turnos: ${meta.badge}, ${meta.label}`}>
              <div className="flex items-center gap-3 px-1 pb-2">
                <span
                  className={cn(
                    "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-2xl leading-none",
                    meta.isToday
                      ? "bg-accent/20 text-foreground"
                      : "bg-surface-soft text-foreground",
                  )}
                >
                  <span className="text-body font-bold leading-5">{day.getDate()}</span>
                  <span className="text-meta capitalize leading-4 opacity-70">
                    {new Intl.DateTimeFormat("es", { month: "short" }).format(day).replace(".", "")}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold leading-6 text-foreground">
                    Turnos
                  </p>
                  <p className="text-meta leading-4 text-muted-foreground">
                    {meta.badge} · {marks.length === 1 ? "1 turno" : `${marks.length} turnos`}
                  </p>
                </div>
              </div>
              <ol className="relative ml-[22px] flex flex-col gap-2 border-l border-dashed border-divider pl-4">
                {marks.map((mark) => (
                  <li key={mark.taskId} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-background bg-accent"
                    />
                    <button
                      type="button"
                      onClick={() => onSelectShift?.(mark)}
                      aria-label={`Turno: ${mark.title}`}
                      className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-divider px-4 py-2.5 text-left outline-none interactive"
                    >
                      <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground">
                        {mark.title}
                      </span>
                      <span className="shrink-0 text-meta text-muted-foreground">Turno</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          </li>
        );
      })}
    </ol>
  );
}
