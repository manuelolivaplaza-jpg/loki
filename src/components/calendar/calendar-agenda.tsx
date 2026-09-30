"use client";

import * as React from "react";
import { Clock, MapPin } from "lucide-react";
import { Card, CardDivider } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { formatHour } from "@/lib/chat/format";
import { SECTIONS } from "@/components/shell/sections";
import type { EventItem, EventOccurrence } from "@/types/organizer";

function dayTitle(date: Date, today: Date): string {
  const start = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(date) - start(today)) / 86_400_000);
  const label = new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  if (diff === 0) return `Hoy · ${capitalized}`;
  if (diff === 1) return `Mañana · ${capitalized}`;
  return capitalized;
}

export function CalendarAgenda({
  occurrences,
  onSelectEvent,
}: {
  occurrences: EventOccurrence[];
  onSelectEvent: (event: EventItem) => void;
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
    return [...map.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
  }, [occurrences]);

  if (groups.length === 0) {
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
    <div className="flex flex-col gap-4">
      {groups.map(({ day, items }) => (
        <section key={day.toISOString()} aria-label={dayTitle(day, today)}>
          <p className="px-2 pb-1 text-meta font-medium text-muted-foreground">
            {dayTitle(day, today)}
          </p>
          <Card>
            {items.map((occurrence, index) => (
              <React.Fragment key={occurrence.occurrenceId}>
                {index > 0 ? <CardDivider /> : null}
                <button
                  type="button"
                  onClick={() => onSelectEvent(occurrence)}
                  aria-label={`${occurrence.title}, ${formatHour(occurrence.startsAt)}`}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none interactive"
                >
                  <span
                    aria-hidden="true"
                    className="h-10 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: occurrence.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold leading-6 text-foreground">
                      {occurrence.title}
                    </span>
                    <span className="flex items-center gap-2 text-meta leading-5 text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Icon icon={Clock} size={20} />
                        {occurrence.allDay ? "Todo el día" : formatHour(occurrence.startsAt)}
                      </span>
                      {occurrence.location !== "" ? (
                        <span className="flex min-w-0 items-center gap-1">
                          <Icon icon={MapPin} size={20} />
                          <span className="truncate">{occurrence.location}</span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </React.Fragment>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
