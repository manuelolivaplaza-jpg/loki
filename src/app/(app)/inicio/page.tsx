"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CalendarPlus,
  ChevronRight,
  FolderPlus,
  Lightbulb,
  Sunrise,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ProgressRing } from "@/components/ui/progress-ring";
import { SectionLabel } from "@/components/ui/section-label";
import { WeekStrip } from "@/components/ui/week-strip";
import { TodayView } from "@/components/daily/today-view";
import { PlaceholderDialog } from "@/components/shell/quick-actions";
import { InviteDialog } from "@/components/members/invite-dialog";
import {
  useEventOccurrences,
  useProjects,
  useShoppingLists,
  useUpdateTask,
  useWorkspaceTasks,
} from "@/hooks/use-organizer";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { EventOccurrence, TaskItem } from "@/types/organizer";

function greetingForHour(hour: number): string {
  if (hour >= 7 && hour < 13) return "Buenos días";
  if (hour >= 13 && hour < 21) return "Buenas tardes";
  return "Buenas noches";
}

type QuickAccess = {
  key: string;
  label: string;
  icon: LucideIcon;
};

const QUICK_ACCESS: readonly QuickAccess[] = [
  { key: "idea", label: "Nueva idea", icon: Lightbulb },
  { key: "evento", label: "Nuevo evento", icon: CalendarPlus },
  { key: "proyecto", label: "Nuevo proyecto", icon: FolderPlus },
  { key: "invitar", label: "Invitar", icon: UserPlus },
];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function eventWhenLabel(start: Date, now: Date): string {
  const time = `${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}`;
  const diffDays = Math.round((startOfDay(start).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (diffDays <= 0) return `Hoy · ${time}`;
  if (diffDays === 1) return `Mañana · ${time}`;
  const day = new Intl.DateTimeFormat("es", { weekday: "short" }).format(start).replace(".", "");
  const capitalized = day.charAt(0).toUpperCase() + day.slice(1);
  return `${capitalized} · ${time}`;
}

function taskMeta(task: TaskItem, projectName: string | null): string {
  const parts: string[] = [];
  if (task.dueAt !== null) {
    const date = task.dueAt.toDate();
    parts.push(
      `Hoy · ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`,
    );
  } else {
    parts.push("Sin hora");
  }
  if (projectName !== null && projectName !== "") parts.push(projectName);
  return parts.join(" · ");
}

export default function InicioPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={null}>
      <InicioContent />
    </React.Suspense>
  );
}

/**
 * La push del resumen diario abre `/inicio?vista=dia` (query param por el
 * export estático): ahí se pinta "Tu día" en vez del Inicio normal.
 */
function InicioContent(): React.JSX.Element {
  const searchParams = useSearchParams();
  const vistaDia = searchParams.get("vista") === "dia";
  if (vistaDia) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-4">
        <header className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-foreground">
            <Icon icon={Sunrise} size={22} />
          </span>
          <h1 className="min-w-0 flex-1 text-display font-semibold text-foreground">
            Tu día
          </h1>
          <Link
            href="/inicio"
            className="shrink-0 text-body-sm font-semibold text-mention outline-none interactive"
          >
            Inicio
          </Link>
        </header>
        <div className="mt-4">
          <TodayView />
        </div>
      </div>
    );
  }
  return <InicioHome />;
}

function InicioHome(): React.JSX.Element {
  const profile = useProfileStore((state) => state.profile);
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const [quickAccess, setQuickAccess] = React.useState<QuickAccess | null>(null);

  const now = React.useMemo(() => new Date(), []);
  const weekStart = React.useMemo(() => {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return monday;
  }, [now]);
  const weekEnd = React.useMemo(() => {
    const end = new Date(weekStart.getTime());
    end.setDate(end.getDate() + 7);
    return end;
  }, [weekStart]);
  const monthEnd = React.useMemo(() => {
    const end = new Date(now.getTime());
    end.setDate(end.getDate() + 30);
    return end;
  }, [now]);

  const tasksQuery = useWorkspaceTasks(currentWorkspaceId);
  const projectsQuery = useProjects(currentWorkspaceId);
  const weekQuery = useEventOccurrences(currentWorkspaceId, weekStart, weekEnd);
  const upcomingQuery = useEventOccurrences(currentWorkspaceId, now, monthEnd);
  const listsQuery = useShoppingLists(currentWorkspaceId);
  const pinnedLists = (listsQuery.data ?? []).filter((list) => list.pinned);
  const updateTask = useUpdateTask();
  const [taskError, setTaskError] = React.useState<string | null>(null);

  const tasks = React.useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.parentTaskId === null),
    [tasksQuery.data],
  );
  const projectsById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) map.set(project.id, project.name);
    return map;
  }, [projectsQuery.data]);

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const progress = tasks.length === 0 ? 0 : Math.round((doneCount / tasks.length) * 100);
  const activeProjects = (projectsQuery.data ?? []).filter(
    (project) => project.status === "active",
  ).length;

  const weekDays = React.useMemo(() => {
    const marks = new Array<boolean>(7).fill(false);
    for (const occurrence of weekQuery.occurrences) {
      const start = occurrence.startsAt.toDate();
      for (let index = 0; index < 7; index += 1) {
        const day = new Date(weekStart.getTime());
        day.setDate(day.getDate() + index);
        const next = new Date(day.getTime() + 86_400_000);
        if (start.getTime() >= day.getTime() && start.getTime() < next.getTime()) {
          marks[index] = true;
        }
      }
    }
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(weekStart.getTime());
      day.setDate(day.getDate() + index);
      return { day: day.getDate(), hasEvents: marks[index] ?? false };
    });
  }, [weekQuery.occurrences, weekStart]);
  const todayIndex = (now.getDay() + 6) % 7;
  const [selectedDayIndex, setSelectedDayIndex] = React.useState(todayIndex);

  // Día seleccionado de la tira semanal (por defecto hoy): la tarjeta
  // muestra sus tareas (vencen ese día; hoy incluye las atrasadas) y
  // sus eventos.
  const selectedDate = React.useMemo(() => {
    const day = new Date(weekStart.getTime());
    day.setDate(day.getDate() + selectedDayIndex);
    return day;
  }, [weekStart, selectedDayIndex]);
  const selectedStart = startOfDay(selectedDate).getTime();
  const isSelectedToday = selectedStart === startOfDay(now).getTime();
  const selectedLabel = isSelectedToday
    ? "Hoy"
    : (() => {
      const raw = new Intl.DateTimeFormat("es", { weekday: "long" }).format(selectedDate);
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    })();

  const dayTasks = React.useMemo(() => {
    return tasks
      .filter((task) => {
        if (task.status === "done" || task.dueAt === null) return false;
        const due = startOfDay(task.dueAt.toDate()).getTime();
        return isSelectedToday ? due <= selectedStart : due === selectedStart;
      })
      .sort((a, b) => (a.dueAt?.toMillis() ?? 0) - (b.dueAt?.toMillis() ?? 0));
  }, [tasks, selectedStart, isSelectedToday]);

  const dayEvents = React.useMemo(() => {
    const end = selectedStart + 86_400_000;
    return weekQuery.occurrences.filter((occurrence) => {
      const start = occurrence.startsAt.toMillis();
      const finish = occurrence.endsAt.toMillis();
      return start < end && finish > selectedStart;
    });
  }, [weekQuery.occurrences, selectedStart]);

  const upcoming = React.useMemo<EventOccurrence[]>(
    () => upcomingQuery.occurrences.filter((o) => o.endsAt.toMillis() >= now.getTime()).slice(0, 4),
    [upcomingQuery.occurrences, now],
  );

  const firstName =
    (profile?.displayName.trim() !== "" ? profile?.displayName : null) ??
    user?.displayName ??
    "";
  const shortName = firstName.trim().split(" ")[0] ?? "";
  const greeting = greetingForHour(now.getHours());
  const rawDateLabel = new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const dateLabel =
    rawDateLabel.charAt(0).toUpperCase() + rawDateLabel.slice(1);

  function toggleTask(task: TaskItem, checked: boolean): void {
    setTaskError(null);
    updateTask.mutate(
      { id: task.id, patch: { status: checked ? "done" : "todo" } },
      { onError: (error) => setTaskError(error.message) },
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <header>
        <h1 className="text-display font-semibold text-foreground">
          {shortName === "" ? greeting : `${greeting}, ${shortName}`}
        </h1>
        <p className="mt-1 text-body-sm text-muted-foreground">
          {dateLabel}
        </p>
      </header>

      {/* Tarjeta "Tu día": la push del resumen también abre /inicio?vista=dia. */}
      <Link
        href="/inicio?vista=dia"
        aria-label={`Tu día, ${dayTasks.length + dayEvents.length} cosas hoy`}
        className="mt-4 flex min-h-14 items-center gap-3 rounded-lg border border-divider bg-background px-4 py-3 outline-none interactive"
      >
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-foreground">
          <Icon icon={Sunrise} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold text-foreground">
            Tu día
          </span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {dayTasks.length + dayEvents.length === 0
              ? "Nada pendiente hoy"
              : `${dayTasks.length + dayEvents.length} ${dayTasks.length + dayEvents.length === 1 ? "cosa" : "cosas"} hoy`}
          </span>
        </span>
        <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
      </Link>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 min-[1440px]:grid-cols-3">
        <section aria-label="Progreso">
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">Progreso</h2>
            <div className="mt-3 flex items-center gap-4">
              <ProgressRing value={progress} />
              <ul className="flex min-w-0 flex-1 flex-col gap-2">
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    Tareas completadas
                  </span>
                  <span className="text-body-sm font-semibold text-foreground">
                    {doneCount}/{tasks.length}
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    Proyectos activos
                  </span>
                  <span className="text-body-sm font-semibold text-foreground">
                    {activeProjects}
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    Eventos esta semana
                  </span>
                  <span className="text-body-sm font-semibold text-foreground">
                    {weekQuery.occurrences.length}
                  </span>
                </li>
              </ul>
            </div>
          </Card>
        </section>

        <section aria-label={selectedLabel}>
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">
              {selectedLabel} · {dayTasks.length + dayEvents.length}
            </h2>
            {dayTasks.length === 0 && dayEvents.length === 0 ? (
              <p className="mt-2 text-body-sm text-muted-foreground">
                {isSelectedToday ? "Nada vence hoy. Disfruta el día." : `Nada para el ${selectedLabel.toLowerCase()}.`}
              </p>
            ) : (
              <ul className="mt-2 flex flex-col">
                {dayTasks.map((task, index) => (
                  <React.Fragment key={`task-${task.id}`}>
                    {index > 0 ? <CardDivider className="mx-0" /> : null}
                    <li className="flex items-center gap-3 py-3">
                      <Checkbox
                        checked={task.status === "done"}
                        onCheckedChange={(checked) => toggleTask(task, checked)}
                        label={task.title}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm font-medium text-foreground">
                          {task.title}
                        </span>
                        <span className="block text-meta text-muted-foreground">
                          {taskMeta(task, projectsById.get(task.projectId) ?? null)}
                        </span>
                      </span>
                    </li>
                  </React.Fragment>
                ))}
                {dayEvents.map((occurrence, index) => (
                  <React.Fragment key={occurrence.occurrenceId}>
                    {index > 0 || dayTasks.length > 0 ? <CardDivider className="mx-0" /> : null}
                    <li className="flex items-center gap-3 py-3">
                      <span
                        aria-hidden="true"
                        className="h-8 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: occurrence.color }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm font-medium text-foreground">
                          {occurrence.title}
                        </span>
                        <span className="block text-meta text-muted-foreground">
                          {eventWhenLabel(occurrence.startsAt.toDate(), now)}
                          {occurrence.location !== "" ? ` · ${occurrence.location}` : ""}
                        </span>
                      </span>
                    </li>
                  </React.Fragment>
                ))}
              </ul>
            )}
            {taskError !== null ? (
              <p role="alert" className="mt-1 text-meta text-danger">
                {taskError}
              </p>
            ) : null}
          </Card>
        </section>

        <section aria-label="Esta semana">
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">
              Esta semana
            </h2>
            <div className="mt-2">
              <WeekStrip
                days={weekDays}
                todayIndex={todayIndex}
                selectedIndex={selectedDayIndex}
                onSelectDay={setSelectedDayIndex}
              />
            </div>
          </Card>
        </section>

        <section aria-label="Próximos eventos">
          <SectionLabel>Próximos eventos</SectionLabel>
          {upcoming.length === 0 ? (
            <Card>
              <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
                Sin eventos próximos.
              </p>
            </Card>
          ) : (
            <Card>
              {upcoming.map((occurrence, index) => (
                <React.Fragment key={occurrence.occurrenceId}>
                  {index > 0 ? <CardDivider /> : null}
                  <CardRow>
                    <span className="w-24 shrink-0 text-meta leading-5 text-muted-foreground">
                      {eventWhenLabel(occurrence.startsAt.toDate(), now)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm font-medium text-foreground">
                        {occurrence.title}
                      </span>
                      {occurrence.location !== "" ? (
                        <span className="block truncate text-meta text-muted-foreground">
                          {occurrence.location}
                        </span>
                      ) : null}
                    </span>
                    <Link
                      href="/calendario"
                      aria-label={`Ver ${occurrence.title} en el calendario`}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none interactive"
                    >
                      <Icon icon={ChevronRight} size={20} className="text-muted-foreground" />
                    </Link>
                  </CardRow>
                </React.Fragment>
              ))}
            </Card>
          )}
        </section>

        {pinnedLists.length > 0 ? (
          <section aria-label="Listas fijadas">
            <SectionLabel>Listas fijadas</SectionLabel>
            <Card>
              {pinnedLists.map((list, index) => (
                <React.Fragment key={list.id}>
                  {index > 0 ? <CardDivider /> : null}
                  <CardRow>
                    <span aria-hidden="true" className="shrink-0 text-body">
                      {list.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm font-medium text-foreground">
                        {list.title}
                      </span>
                      <span className="block text-meta leading-4 text-muted-foreground">
                        {list.total === 0
                          ? "Vacía"
                          : list.open === 0
                            ? "Completa"
                            : `Faltan ${list.open} de ${list.total}`}
                      </span>
                    </span>
                    <Link
                      href={`/proyectos?tab=listas&list=${encodeURIComponent(list.id)}`}
                      aria-label={`Abrir ${list.title}`}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none interactive"
                    >
                      <Icon icon={ChevronRight} size={20} className="text-muted-foreground" />
                    </Link>
                  </CardRow>
                </React.Fragment>
              ))}
            </Card>
          </section>
        ) : null}

        <section aria-label="Accesos rápidos">
          <SectionLabel>Accesos rápidos</SectionLabel>          <Card className="p-4">
            <ul className="grid grid-cols-4 gap-2">
              {QUICK_ACCESS.map((action) => (
                <li
                  key={action.key}
                  className="flex flex-col items-center gap-2"
                >
                  <IconButton
                    variant="ghost"
                    aria-label={action.label}
                    onClick={() =>
                      setQuickAccess({ key: action.key, label: action.label, icon: action.icon })
                    }
                    className="bg-surface text-foreground"
                  >
                    <Icon icon={action.icon} size={22} />
                  </IconButton>
                  <span className="text-center text-meta leading-4 text-muted-foreground">
                    {action.label}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      </div>

      {quickAccess?.key === "invitar" ? (
        <InviteDialog
          open={quickAccess !== null}
          wsId={currentWorkspaceId}
          onClose={() => setQuickAccess(null)}
        />
      ) : (
        <PlaceholderDialog
          title={quickAccess?.label ?? ""}
          open={quickAccess !== null}
          onClose={() => setQuickAccess(null)}
        />
      )}
    </div>
  );
}
