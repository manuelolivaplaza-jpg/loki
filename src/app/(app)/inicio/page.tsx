"use client";

import * as React from "react";
import Link from "next/link";
import {
  CalendarPlus,
  ChevronRight,
  FolderPlus,
  Lightbulb,
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
import { PlaceholderDialog } from "@/components/shell/quick-actions";
import {
  useEventOccurrences,
  useProjects,
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

  const todayTasks = React.useMemo(() => {
    const start = startOfDay(now).getTime();
    return tasks
      .filter((task) => {
        if (task.status === "done" || task.dueAt === null) return false;
        const due = startOfDay(task.dueAt.toDate()).getTime();
        return due <= start;
      })
      .sort((a, b) => (a.dueAt?.toMillis() ?? 0) - (b.dueAt?.toMillis() ?? 0));
  }, [tasks, now]);

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

        <section aria-label="Hoy">
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">
              Hoy · {todayTasks.length}
            </h2>
            {todayTasks.length === 0 ? (
              <p className="mt-2 text-body-sm text-muted-foreground">
                Nada vence hoy. Disfruta el día.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col">
                {todayTasks.map((task, index) => (
                  <React.Fragment key={task.id}>
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
              <WeekStrip days={weekDays} todayIndex={todayIndex} />
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

        <section aria-label="Accesos rápidos">
          <SectionLabel>Accesos rápidos</SectionLabel>
          <Card className="p-4">
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

      <PlaceholderDialog
        title={quickAccess?.label ?? ""}
        open={quickAccess !== null}
        onClose={() => setQuickAccess(null)}
      />
    </div>
  );
}
