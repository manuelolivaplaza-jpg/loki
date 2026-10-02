"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { QueryRetry } from "@/components/ui/query-retry";
import { useEventOccurrences } from "@/hooks/use-organizer";
import { useSeriesOccurrences } from "@/hooks/use-series";
import { useGcal } from "@/hooks/use-gcal";
import { useWorkspaces } from "@/stores/workspace-store";
import type { EventItem, EventOccurrence } from "@/types/organizer";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import { CalendarMonth } from "@/components/calendar/calendar-month";
import { CalendarWeek } from "@/components/calendar/calendar-week";
import { CalendarAgenda } from "@/components/calendar/calendar-agenda";

/** Diálogo pesado por code splitting: solo se descarga al crear/editar. */
const EventDialog = dynamic(
  () => import("@/components/calendar/event-dialog").then((mod) => mod.EventDialog),
  { ssr: false },
);

export type CalendarView = "month" | "week" | "agenda";

const VIEWS: readonly { key: CalendarView; label: string }[] = [
  { key: "month", label: "Mes" },
  { key: "week", label: "Semana" },
  { key: "agenda", label: "Agenda" },
];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeekMonday(date: Date): Date {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - offset);
  return out;
}

function defaultView(): CalendarView {
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
    return "agenda";
  }
  return "week";
}

function monthRange(anchor: Date): { from: Date; to: Date } {
  const first = startOfMonth(anchor);
  const start = startOfWeekMonday(first);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 42);
  return { from: start, to: end };
}

function weekRange(anchor: Date): { from: Date; to: Date } {
  const start = startOfWeekMonday(anchor);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { from: start, to: end };
}

function agendaRange(anchor: Date): { from: Date; to: Date } {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 30);
  return { from: start, to: end };
}

export function CalendarView(): React.JSX.Element {
  const router = useRouter();
  const { currentWorkspaceId } = useWorkspaces();
  const [view, setView] = React.useState<CalendarView>(defaultView);
  const [anchor, setAnchor] = React.useState(() => new Date());
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EventItem | null>(null);
  const [presetStart, setPresetStart] = React.useState<Date | null>(null);

  const range =
    view === "month" ? monthRange(anchor) : view === "week" ? weekRange(anchor) : agendaRange(anchor);
  const { occurrences, isPending, error, retry } = useEventOccurrences(currentWorkspaceId, range.from, range.to);
  // Turnos y tareas recurrentes: marcas discretas (las ocurrencias son tareas
  // normales de una serie, generadas por la base).
  const shiftsQuery = useSeriesOccurrences(currentWorkspaceId, range.from, range.to);
  const shiftMarks = React.useMemo(
    () =>
      (shiftsQuery.data ?? [])
        .filter((task) => task.due_at !== null)
        .map((task) => ({
          date: new Date(task.due_at as string),
          mark: {
            taskId: task.id,
            projectId: task.project_id,
            title: task.title,
            assigneeId: task.assignee_ids[0] ?? "",
          },
        })),
    [shiftsQuery.data],
  );

  // Pull automático de Google al abrir el calendario: si hay conexión y el
  // último sync tiene más de 15 min (o nunca hubo), importa y refresca
  // ["events"]. Sin conexión es no-op. Una sola vez por montaje.
  const { status: gcalStatus, pull: gcalPull } = useGcal();
  const autoPulledRef = React.useRef(false);
  React.useEffect(() => {
    if (autoPulledRef.current) return;
    if (!gcalStatus.connected) return;
    const last = gcalStatus.lastPullAt === null ? null : new Date(gcalStatus.lastPullAt).getTime();
    const stale = last === null || Number.isNaN(last) || Date.now() - last > 15 * 60_000;
    if (!stale) return;
    autoPulledRef.current = true;
    void gcalPull();
    // Solo depende del estado de conexión: el pull invalida ["gcal"] y no
    // debe re-dispararse por el refresco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcalStatus.connected]);

  function shift(direction: 1 | -1): void {
    setAnchor((current) => {
      const next = new Date(current.getTime());
      if (view === "month") next.setMonth(next.getMonth() + direction);
      else if (view === "week") next.setDate(next.getDate() + 7 * direction);
      else next.setDate(next.getDate() + 7 * direction);
      return next;
    });
  }

  function openCreate(start?: Date): void {
    setEditing(null);
    setPresetStart(start ?? null);
    setDialogOpen(true);
  }

  function openEdit(event: EventItem | EventOccurrence): void {
    setEditing(event);
    setPresetStart(null);
    setDialogOpen(true);
  }

  const title = new Intl.DateTimeFormat("es", { month: "long" }).format(anchor);
  const titleLabel = title.charAt(0).toUpperCase() + title.slice(1);
  const yearLabel = new Intl.DateTimeFormat("es", { year: "numeric" }).format(anchor);
  const isCurrentPeriod = React.useMemo(() => {
    const now = new Date();
    if (view === "month") {
      return now.getFullYear() === anchor.getFullYear() && now.getMonth() === anchor.getMonth();
    }
    const start = view === "week" ? weekRange(anchor).from : agendaRange(anchor).from;
    const end = view === "week" ? weekRange(anchor).to : agendaRange(anchor).to;
    return now.getTime() >= start.getTime() && now.getTime() <= end.getTime();
  }, [view, anchor]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-meta font-medium leading-4 text-muted-foreground">{yearLabel}</p>
          <h1 className="truncate text-display font-bold leading-tight text-foreground">
            {titleLabel}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isCurrentPeriod ? (
            <button
              type="button"
              onClick={() => setAnchor(new Date())}
              className="h-9 rounded-full px-3 text-body-sm font-semibold text-mention outline-none interactive"
            >
              Hoy
            </button>
          ) : null}
          <div className="flex items-center rounded-full bg-surface-soft p-0.5">
            <IconButton variant="ghost" aria-label="Anterior" onClick={() => shift(-1)} className="h-9 w-9">
              <Icon icon={ChevronLeft} size={20} />
            </IconButton>
            <IconButton variant="ghost" aria-label="Siguiente" onClick={() => shift(1)} className="h-9 w-9">
              <Icon icon={ChevronRight} size={20} />
            </IconButton>
          </div>
          <IconButton variant="solid" aria-label="Crear evento" onClick={() => openCreate()}>
            <Icon icon={Plus} size={20} />
          </IconButton>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Vista del calendario"
        className="mt-3 flex rounded-full bg-surface-soft p-1"
      >
        {VIEWS.map((item) => {
          const selected = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={item.label}
              onClick={() => setView(item.key)}
              className={cn(
                "h-9 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                selected
                  ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                  : "text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {error !== null && occurrences.length === 0 ? (
          <QueryRetry
            message="No se pudieron cargar los eventos."
            onRetry={retry}
          />
        ) : isPending && occurrences.length === 0 ? (
          <div aria-label="Cargando calendario" className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className="block h-16 animate-pulse rounded-lg bg-surface-soft"
              />
            ))}
          </div>
        ) : view === "month" ? (
          <CalendarMonth
            anchor={anchor}
            occurrences={occurrences}
            shifts={shiftMarks}
            onSelectDay={(day) => openCreate(day)}
            onSelectEvent={openEdit}
            onSelectShift={(mark) =>
              router.push(
                `/proyectos?project=${encodeURIComponent(mark.projectId)}&task=${encodeURIComponent(mark.taskId)}`,
              )
            }
          />
        ) : view === "week" ? (
          <CalendarWeek anchor={anchor} occurrences={occurrences} onSelectEvent={openEdit} />
        ) : (
          <CalendarAgenda
            occurrences={occurrences}
            shifts={shiftMarks}
            onSelectEvent={openEdit}
            onSelectShift={(mark) =>
              router.push(
                `/proyectos?project=${encodeURIComponent(mark.projectId)}&task=${encodeURIComponent(mark.taskId)}`,
              )
            }
          />
        )}
      </div>

      {dialogOpen ? (
        <EventDialog
          open={dialogOpen}
          event={editing}
          presetStart={presetStart}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
