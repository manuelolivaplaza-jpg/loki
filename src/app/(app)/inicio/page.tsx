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
import { Avatar } from "@/components/ui/avatar";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ProgressRing } from "@/components/ui/progress-ring";
import { SectionLabel } from "@/components/ui/section-label";
import { WeekStrip } from "@/components/ui/week-strip";
import { PlaceholderDialog } from "@/components/shell/quick-actions";
import { HOME_MOCK, HOME_WEEK_MARKS, type HomeDayMark } from "@/lib/mock/home";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";

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

export default function InicioPage(): React.JSX.Element {
  const profile = useProfileStore((state) => state.profile);
  const user = useSessionStore((state) => state.user);
  const [tasks, setTasks] = React.useState(HOME_MOCK.todayTasks);
  const [quickAccess, setQuickAccess] = React.useState<QuickAccess | null>(null);

  const now = React.useMemo(() => new Date(), []);
  const [weekDays, setWeekDays] = React.useState<readonly HomeDayMark[] | null>(
    null,
  );
  const [todayIndex, setTodayIndex] = React.useState(-1);

  React.useEffect(() => {
    const current = new Date();
    const mondayOffset = (current.getDay() + 6) % 7;
    const monday = new Date(current);
    monday.setDate(current.getDate() - mondayOffset);
    const days: HomeDayMark[] = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + index);
      return {
        day: date.getDate(),
        hasEvents: HOME_WEEK_MARKS[index]?.hasEvents ?? false,
      };
    });
    setWeekDays(days);
    setTodayIndex(mondayOffset);
  }, []);
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

  const doneCount = tasks.filter((task) => task.done).length;
  const progress =
    HOME_MOCK.tasksTotal === 0
      ? 0
      : Math.round((HOME_MOCK.tasksCompleted / HOME_MOCK.tasksTotal) * 100);

  function toggleTask(id: string, checked: boolean): void {
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, done: checked } : task)),
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
                    {HOME_MOCK.tasksCompleted}/{HOME_MOCK.tasksTotal}
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    Proyectos activos
                  </span>
                  <span className="text-body-sm font-semibold text-foreground">
                    {HOME_MOCK.activeProjects}
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    Eventos esta semana
                  </span>
                  <span className="text-body-sm font-semibold text-foreground">
                    {HOME_MOCK.weekEvents}
                  </span>
                </li>
              </ul>
            </div>
          </Card>
        </section>

        <section aria-label="Hoy">
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">
              Hoy · {doneCount}/{tasks.length}
            </h2>
            <ul className="mt-2 flex flex-col">
              {tasks.map((task, index) => (
                <React.Fragment key={task.id}>
                  {index > 0 ? <CardDivider className="mx-0" /> : null}
                  <li className="flex items-center gap-3 py-3">
                    <Checkbox
                      checked={task.done}
                      onCheckedChange={(checked) => toggleTask(task.id, checked)}
                      label={task.title}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm font-medium text-foreground">
                        {task.title}
                      </span>
                      <span className="block text-meta text-muted-foreground">
                        {task.meta}
                      </span>
                    </span>
                  </li>
                </React.Fragment>
              ))}
            </ul>
          </Card>
        </section>

        <section aria-label="Esta semana">
          <Card className="h-full p-4">
            <h2 className="text-body font-semibold text-foreground">
              Esta semana
            </h2>
            <div className="mt-2">
              {weekDays === null ? (
                <ol aria-label="Semana actual" className="grid grid-cols-7">
                  {["L", "M", "M", "J", "V", "S", "D"].map((letter, index) => (
                    <li
                      key={`${letter}-${index}`}
                      className="flex flex-col items-center gap-1 py-2"
                      aria-hidden="true"
                    >
                      <span className="text-meta leading-4 text-muted-foreground">
                        {letter}
                      </span>
                      <span className="flex h-8 w-8 items-center justify-center">
                        <span className="h-8 w-8 animate-pulse rounded-full bg-surface-soft" />
                      </span>
                      <span className="flex h-1 items-center" />
                    </li>
                  ))}
                </ol>
              ) : (
                <WeekStrip days={weekDays} todayIndex={todayIndex} />
              )}
            </div>
          </Card>
        </section>

        <section aria-label="Próximos eventos">
          <SectionLabel>Próximos eventos</SectionLabel>
          <Card>
            {HOME_MOCK.upcomingEvents.map((event, index) => (
              <React.Fragment key={event.id}>
                {index > 0 ? <CardDivider /> : null}
                <CardRow>
                  <span className="w-24 shrink-0 text-meta leading-5 text-muted-foreground">
                    {event.when}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium text-foreground">
                      {event.title}
                    </span>
                    {event.location !== undefined ? (
                      <span className="block truncate text-meta text-muted-foreground">
                        {event.location}
                      </span>
                    ) : null}
                  </span>
                  <Link
                    href="/calendario"
                    aria-label={`Ver ${event.title} en el calendario`}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none interactive"
                  >
                    <Icon icon={ChevronRight} size={20} className="text-muted-foreground" />
                  </Link>
                </CardRow>
              </React.Fragment>
            ))}
          </Card>
        </section>

        <section aria-label="Actividad reciente">
          <SectionLabel>Actividad reciente</SectionLabel>
          <Card className="px-2 py-2">
            <ul className="flex flex-col">
              {HOME_MOCK.recentActivity.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-3 outline-none interactive"
                >
                  <Avatar
                    initial={item.name.charAt(0)}
                    color={item.color}
                    size={40}
                  />
                  <p className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                    <span className="font-semibold">{item.name}</span>{" "}
                    <span className="text-muted-foreground">{item.text}</span>
                  </p>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {item.time}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
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
