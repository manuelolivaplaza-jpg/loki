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

function dayLabel(day: Date): string {
  const name = new Intl.DateTimeFormat("es", { weekday: "short" }).format(day).replace(".", "");
  return `${name} ${day.getDate()}`;
}

/** Mueve el evento base tantos días (arrastrar en Semana). */
function shiftDays(event: EventItem, days: number): { startsAt: Date; endsAt: Date } {
  const delta = days * 86_400_000;
  return {
    startsAt: new Date(event.startsAt.toMillis() + delta),
    endsAt: new Date(event.endsAt.toMillis() + delta),
  };
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
  const today = React.useMemo(() => new Date(), []);
  const hours = React.useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i),
    [],
  );

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

  return (
    <div>
      <div className="grid grid-cols-7 gap-px" role="row">
        {days.map((day) => {
          const isToday =
            day.getFullYear() === today.getFullYear() &&
            day.getMonth() === today.getMonth() &&
            day.getDate() === today.getDate();
          return (
            <div key={day.toISOString()} className="pb-1 text-center">
              <span
                className={cn(
                  "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-meta font-medium leading-4",
                  isToday
                    ? "bg-foreground text-background dark:bg-white dark:text-black"
                    : "text-muted-foreground",
                )}
              >
                {dayLabel(day)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-divider">
        {days.map((day) => {
          const dayEvents = occurrences.filter((occurrence) => {
            const start = occurrence.startsAt.toDate();
            const end = occurrence.endsAt.toDate();
            const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
            const dayEnd = new Date(dayStart.getTime() + 86_400_000);
            return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
          });
          return (
            <div
              key={day.toISOString()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const occurrenceId = event.dataTransfer.getData("text/loki-event");
                if (occurrenceId !== "") dropOnDay(day, occurrenceId);
              }}
              className="relative bg-background"
              style={{ height: (DAY_END_HOUR - DAY_START_HOUR) * PX_PER_HOUR }}
            >
              {hours.map((hour) => (
                <div
                  key={hour}
                  aria-hidden="true"
                  className="border-t border-divider"
                  style={{ height: PX_PER_HOUR }}
                />
              ))}
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
                const height = Math.max(20, bottom - top);
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
                    className="absolute inset-x-0.5 overflow-hidden rounded-sm px-1 text-left outline-none interactive"
                    style={{
                      top,
                      height,
                      backgroundColor: `${occurrence.color}30`,
                      borderLeft: `3px solid ${occurrence.color}`,
                    }}
                  >
                    <span className="block truncate text-meta font-semibold leading-4 text-foreground">
                      {occurrence.title}
                    </span>
                    <span className="block truncate text-meta leading-4 text-muted-foreground">
                      {formatHour(occurrence.startsAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {dragError !== null ? (
        <p role="alert" className="mt-2 text-meta text-danger">
          {dragError}
        </p>
      ) : null}
    </div>
  );
}
