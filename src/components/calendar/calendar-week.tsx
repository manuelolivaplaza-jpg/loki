"use client";

import * as React from "react";
import { formatHour } from "@/lib/chat/format";
import { useUpdateEvent } from "@/hooks/use-organizer";
import { useWorkspaces } from "@/stores/workspace-store";
import type { EventItem, EventOccurrence } from "@/types/organizer";
import { cn } from "@/lib/utils";

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22;
const PX_PER_HOUR = 48;
const GUTTER_WIDTH = 44;

function weekdayShort(day: Date): string {
  return new Intl.DateTimeFormat("es", { weekday: "short" }).format(day).replace(".", "");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Mueve el evento base tantos días (arrastrar en Semana). */
function shiftDays(event: EventItem, days: number): { startsAt: Date; endsAt: Date } {
  const delta = days * 86_400_000;
  return {
    startsAt: new Date(event.startsAt.toMillis() + delta),
    endsAt: new Date(event.endsAt.toMillis() + delta),
  };
}

function overlapsDay(occurrence: EventOccurrence, day: Date): boolean {
  const start = occurrence.startsAt.toDate();
  const end = occurrence.endsAt.toDate();
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
}

export function CalendarWeek({
  anchor,
  occurrences,
  onSelectEvent,
}: {
  anchor: Date;
  occurrences: EventOccurrence[];
  onSelectEvent: (event: EventItem) => void;
}): React.JSX.Element {
  const { currentWorkspaceId } = useWorkspaces();
  const updateEvent = useUpdateEvent();
  const [dragError, setDragError] = React.useState<string | null>(null);
  // Reloj vivo para la línea "ahora" (se actualiza cada minuto).
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const days = React.useMemo(() => {
    const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    const offset = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - offset);
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(monday.getTime());
      day.setDate(day.getDate() + index);
      return day;
    });
  }, [anchor]);
  const hours = React.useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i),
    [],
  );

  const timedByDay = React.useMemo(
    () => days.map((day) => occurrences.filter((o) => overlapsDay(o, day) && !o.allDay)),
    [days, occurrences],
  );
  const allDayByDay = React.useMemo(
    () => days.map((day) => occurrences.filter((o) => overlapsDay(o, day) && o.allDay)),
    [days, occurrences],
  );
  const hasAllDay = allDayByDay.some((list) => list.length > 0);

  function dropOnDay(day: Date, occurrenceId: string): void {
    const occurrence = occurrences.find((item) => item.occurrenceId === occurrenceId);
    if (occurrence === undefined || currentWorkspaceId === null) return;
    const from = occurrence.startsAt.toDate();
    const dayDelta = Math.round(
      (new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() -
        new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) /
        86_400_000,
    );
    if (dayDelta === 0) return;
    setDragError(null);
    const next = shiftDays(occurrence, dayDelta);
    updateEvent.mutate(
      { id: occurrence.id, patch: { startsAt: next.startsAt, endsAt: next.endsAt } },
      { onError: (error) => setDragError(error.message) },
    );
  }

  const gridCols = { gridTemplateColumns: `${GUTTER_WIDTH}px repeat(7, minmax(0, 1fr))` };

  return (
    <div className="overflow-hidden rounded-2xl border border-divider bg-background">
      {/* Cabecera de días */}
      <div className="grid border-b border-divider bg-surface-soft/60" style={gridCols} role="row">
        <span aria-hidden="true" />
        {days.map((day) => {
          const isToday = sameDay(day, now);
          return (
            <div key={day.toISOString()} className="flex flex-col items-center gap-0.5 py-2">
              <span className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                {weekdayShort(day)}
              </span>
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-body font-medium",
                  isToday
                    ? "bg-foreground font-bold text-background dark:bg-white dark:text-black"
                    : "text-foreground",
                )}
              >
                {day.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* Todo el día */}
      {hasAllDay ? (
        <div className="grid border-b border-divider" style={gridCols}>
          <span className="px-1 py-2 text-right text-meta leading-4 text-muted-foreground">
            Todo el día
          </span>
          {allDayByDay.map((list, index) => (
            <div key={days[index]?.toISOString() ?? index} className="flex flex-col gap-1 px-0.5 py-1.5">
              {list.slice(0, 2).map((occurrence) => (
                <button
                  key={occurrence.occurrenceId}
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/loki-event", occurrence.occurrenceId);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onSelectEvent(occurrence)}
                  aria-label={`${occurrence.title}, todo el día`}
                  className="truncate rounded-md px-1.5 py-0.5 text-left text-meta font-medium leading-4 text-foreground outline-none interactive"
                  style={{ backgroundColor: `${occurrence.color}26` }}
                >
                  {occurrence.title}
                </button>
              ))}
              {list.length > 2 ? (
                <span className="px-1.5 text-meta font-medium leading-4 text-accent">
                  +{list.length - 2} más
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Grilla horaria */}
      <div className="grid" style={gridCols}>
        <div aria-hidden="true" className="relative">
          {hours.map((hour) => (
            <div
              key={hour}
              className="relative pr-1 text-right text-meta tabular-nums leading-4 text-muted-foreground"
              style={{ height: PX_PER_HOUR }}
            >
              <span className="absolute -top-2 right-1">
                {hour.toString().padStart(2, "0")}:00
              </span>
            </div>
          ))}
        </div>
        {days.map((day, dayIndex) => {
          const dayEvents = timedByDay[dayIndex] ?? [];
          const isToday = sameDay(day, now);
          const nowTop =
            isToday
              ? ((now.getHours() * 60 + now.getMinutes()) / 60 - DAY_START_HOUR) * PX_PER_HOUR
              : null;
          const showNow =
            nowTop !== null && nowTop >= 0 && nowTop <= (DAY_END_HOUR - DAY_START_HOUR) * PX_PER_HOUR;
          return (
            <div
              key={day.toISOString()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const occurrenceId = event.dataTransfer.getData("text/loki-event");
                if (occurrenceId !== "") dropOnDay(day, occurrenceId);
              }}
              className={cn("relative", isToday && "bg-accent/[0.04]")}
              style={{ height: (DAY_END_HOUR - DAY_START_HOUR) * PX_PER_HOUR }}
            >
              {hours.map((hour) => (
                <div
                  key={hour}
                  aria-hidden="true"
                  className="border-t border-divider/70"
                  style={{ height: PX_PER_HOUR }}
                />
              ))}
              {showNow && nowTop !== null ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10"
                  style={{ top: nowTop }}
                >
                  <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-danger" />
                  <span className="block h-0.5 rounded-full bg-danger" />
                </div>
              ) : null}
              {dayEvents.map((occurrence) => {
                const start = occurrence.startsAt.toDate();
                const end = occurrence.endsAt.toDate();
                const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
                const top = Math.max(
                  0,
                  ((start.getTime() - dayStart.getTime()) / 3_600_000 - DAY_START_HOUR) * PX_PER_HOUR,
                );
                const bottom = Math.min(
                  (DAY_END_HOUR - DAY_START_HOUR) * PX_PER_HOUR,
                  ((end.getTime() - dayStart.getTime()) / 3_600_000 - DAY_START_HOUR) * PX_PER_HOUR,
                );
                const height = Math.max(22, bottom - top);
                return (
                  <button
                    key={occurrence.occurrenceId}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/loki-event", occurrence.occurrenceId);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onSelectEvent(occurrence)}
                    aria-label={`${occurrence.title}, ${formatHour(occurrence.startsAt)}`}
                    className="absolute inset-x-1 overflow-hidden rounded-lg px-1.5 py-1 text-left shadow-sm outline-none interactive"
                    style={{
                      top,
                      height,
                      backgroundColor: `${occurrence.color}2e`,
                      borderLeft: `3px solid ${occurrence.color}`,
                    }}
                  >
                    <span className="block truncate text-meta font-semibold leading-4 text-foreground">
                      {occurrence.title}
                    </span>
                    {height >= 40 ? (
                      <span className="block truncate text-meta tabular-nums leading-4 text-muted-foreground">
                        {formatHour(occurrence.startsAt)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {dragError !== null ? (
        <p role="alert" className="border-t border-divider px-4 py-2 text-meta text-danger">
          {dragError}
        </p>
      ) : null}
    </div>
  );
}
