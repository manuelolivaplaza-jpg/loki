"use client";

import * as React from "react";
import type { EventItem, EventOccurrence } from "@/types/organizer";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarMonth({
  anchor,
  occurrences,
  onSelectDay,
  onSelectEvent,
}: {
  anchor: Date;
  occurrences: EventOccurrence[];
  onSelectDay: (day: Date) => void;
  onSelectEvent: (event: EventItem) => void;
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
      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(occurrence);
      map.set(key, list);
    }
    return map;
  }, [occurrences]);

  return (
    <div role="grid" aria-label="Mes">
      <div aria-hidden="true" className="grid grid-cols-7">
        {WEEKDAYS.map((letter, index) => (
          <span
            key={`${letter}-${index}`}
            className="py-1 text-center text-meta font-medium leading-4 text-muted-foreground"
          >
            {letter}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-divider">
        {cells.map((day) => {
          const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const events = (byDay.get(key) ?? []).slice(0, 3);
          const extra = (byDay.get(key) ?? []).length - events.length;
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = sameDay(day, today);
          return (
            <div
              key={key}
              className={cn(
                "flex min-h-[68px] flex-col items-stretch gap-0.5 bg-background p-1 md:min-h-[92px]",
                !inMonth && "opacity-45",
              )}
            >
              <button
                type="button"
                aria-label={`Crear el ${day.getDate()} de ${new Intl.DateTimeFormat("es", { month: "long" }).format(day)}`}
                onClick={() => onSelectDay(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full text-meta leading-4 outline-none interactive",
                  isToday
                    ? "bg-foreground font-semibold text-background dark:bg-white dark:text-black"
                    : "text-foreground",
                )}
              >
                {day.getDate()}
              </button>
              {events.map((occurrence) => (
                <button
                  key={occurrence.occurrenceId}
                  type="button"
                  aria-label={occurrence.title}
                  onClick={() => onSelectEvent(occurrence)}
                  className="truncate rounded-sm px-1 text-left text-meta leading-4 text-foreground outline-none interactive"
                  style={{ backgroundColor: `${occurrence.color}26` }}
                >
                  {occurrence.title}
                </button>
              ))}
              {extra > 0 ? (
                <span className="px-1 text-meta leading-4 text-muted-foreground">
                  +{extra} más
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
