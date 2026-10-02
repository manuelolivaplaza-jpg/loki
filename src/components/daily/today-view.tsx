"use client";

/**
 * Vista "Tu día": eventos de hoy, tareas que vencen/atrasadas, turnos (cuando
 * existan), listas fijadas con pendientes, encuestas por votar y destacados
 * con IA bajo demanda. Agrupada por espacio.
 *
 * Acciones directas: completar tarea, abrir evento, marcar ítem, votar.
 * Móvil en una columna con secciones plegables; escritorio en dos columnas
 * (agenda a la izquierda; tareas, listas y destacados a la derecha).
 */

import * as React from "react";
import Link from "next/link";
import {
  BarChart3,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  ListChecks,
  Repeat,
  Sparkles,
  Sunrise,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { QueryRetry } from "@/components/ui/query-retry";
import { useCheckListItem, useListItems, useUpdateTask } from "@/hooks/use-organizer";
import { useCastPollVote, usePoll } from "@/hooks/use-polls";
import { useDayHighlights, useTodayDigest, type TodaySpaceDigest } from "@/hooks/use-daily-digest";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { TodayList, TodayPoll, TodayShift } from "@/lib/data/daily-digest";
import type { EventOccurrence, TaskItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

function formatTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function Section({
  icon,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  icon: typeof Sunrise;
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section aria-label={title} className="overflow-hidden rounded-lg border border-divider bg-background">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left outline-none interactive"
      >
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground">
          <Icon icon={icon} size={20} />
        </span>
        <span className="min-w-0 flex-1 text-body font-semibold text-foreground">
          {title}
          <span className="ml-2 text-body-sm font-normal text-muted-foreground">{count}</span>
        </span>
        <Icon
          icon={ChevronDown}
          size={20}
          className={cn("shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "")}
        />
      </button>
      {open ? <div className="border-t border-divider px-4 py-2">{children}</div> : null}
    </section>
  );
}

function TaskRow({ task }: { task: TaskItem }): React.JSX.Element {
  const updateTask = useUpdateTask();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Checkbox
        checked={task.status === "done"}
        disabled={updateTask.isPending}
        onCheckedChange={(checked) => {
          setError(null);
          updateTask.mutate(
            { id: task.id, patch: { status: checked ? "done" : "todo" } },
            { onError: (err) => setError(err.message) },
          );
        }}
        label={task.title}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium text-foreground">{task.title}</span>
        {task.dueAt !== null ? (
          <span className="block text-meta text-muted-foreground">
            Vence {formatTime(task.dueAt.toDate())}
          </span>
        ) : null}
        {error !== null ? (
          <span role="alert" className="block text-meta text-danger">{error}</span>
        ) : null}
      </span>
    </li>
  );
}

function EventRow({ occurrence }: { occurrence: EventOccurrence }): React.JSX.Element {
  const start = occurrence.startsAt.toDate();
  return (
    <li>
      <Link
        href="/calendario"
        className="flex items-center gap-3 rounded-sm py-2.5 outline-none interactive"
      >
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
            {formatTime(start)}
            {occurrence.location !== "" ? ` · ${occurrence.location}` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * "Te toca hoy": los turnos rotativos y tareas recurrentes que me tocan. Es una
 * tarea normal (de una serie), así que se completa con el mismo check.
 */
function ShiftRow({ shift }: { shift: TodayShift }): React.JSX.Element {
  const updateTask = useUpdateTask();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Checkbox
        checked={false}
        disabled={updateTask.isPending}
        onCheckedChange={() => {
          setError(null);
          updateTask.mutate(
            { id: shift.id, patch: { status: "done" } },
            { onError: (err) => setError(err.message) },
          );
        }}
        label={shift.title}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium text-foreground">
          {shift.title}
        </span>
        <span className="block text-meta text-muted-foreground">
          {formatTime(shift.dueAt.toDate())} · turno {shift.occurrence}
        </span>
        {error !== null ? (
          <span role="alert" className="block text-meta text-danger">
            {error}
          </span>
        ) : null}
      </span>
      <Link
        href={`/proyectos?project=${encodeURIComponent(shift.projectId)}&task=${encodeURIComponent(shift.id)}`}
        aria-label={`Abrir la tarea ${shift.title}`}
        className="shrink-0 text-body-sm font-semibold text-mention outline-none interactive"
      >
        Abrir
      </Link>
    </li>
  );
}

function PinnedListBlock({ entry, uid }: { entry: TodayList; uid: string }): React.JSX.Element {
  const itemsQuery = useListItems(entry.list.id);
  const checkItem = useCheckListItem(entry.list.id);
  const items = (itemsQuery.data ?? []).filter((item) => !item.checked).slice(0, 5);
  return (
    <div className="py-2">
      <Link
        href={`/proyectos?tab=listas&list=${encodeURIComponent(entry.list.id)}`}
        className="block truncate text-body-sm font-semibold text-foreground outline-none interactive"
      >
        {entry.list.emoji} {entry.list.title} · faltan {entry.open}
      </Link>
      {itemsQuery.isPending ? (
        <p className="mt-1 text-body-sm text-muted-foreground">Cargando ítems…</p>
      ) : (
        <ul className="mt-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-1.5">
              <Checkbox
                checked={false}
                disabled={checkItem.isPending}
                onCheckedChange={(checked) =>
                  checkItem.mutate({ uid, id: item.id, checked })
                }
                label={item.text}
              />
              <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                {item.quantity !== "" ? `${item.quantity}${item.unit !== "" ? ` ${item.unit}` : ""} ` : ""}
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PollVoteBlock({ poll }: { poll: TodayPoll }): React.JSX.Element {
  const { poll: view, isPending } = usePoll(poll.id);
  const vote = useCastPollVote(poll.id);
  const [error, setError] = React.useState<string | null>(null);
  if (isPending) {
    return <p className="py-2 text-body-sm text-muted-foreground">Cargando encuesta…</p>;
  }
  if (view === null) {
    return (
      <div className="py-2">
        <p className="truncate text-body-sm font-medium text-foreground">{poll.question}</p>
        <Link
          href={`/chat/c?id=${encodeURIComponent(poll.chatId)}&msg=${encodeURIComponent(poll.messageId)}`}
          className="text-body-sm font-semibold text-mention outline-none interactive"
        >
          Abrir en el chat
        </Link>
      </div>
    );
  }
  const multiple = view.kind === "multiple";
  function toggle(optionId: string): void {
    setError(null);
    const mine = new Set(view?.options.filter((o) => o.mine).map((o) => o.id) ?? []);
    if (multiple) {
      if (mine.has(optionId)) mine.delete(optionId);
      else mine.add(optionId);
      vote.mutate([...mine], { onError: (err) => setError(err.message) });
    } else {
      vote.mutate([optionId], { onError: (err) => setError(err.message) });
    }
  }
  return (
    <div className="py-2">
      <p className="truncate text-body-sm font-medium text-foreground">{view.question}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {view.options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              onClick={() => toggle(option.id)}
              disabled={vote.isPending || !view.isOpen}
              aria-pressed={option.mine}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-sm px-3 text-left text-body-sm outline-none interactive disabled:opacity-60",
                option.mine ? "bg-mention/15 font-semibold text-foreground" : "bg-surface-soft text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.text}</span>
              <span className="shrink-0 text-meta text-muted-foreground">
                {option.votes} {option.votes === 1 ? "voto" : "votos"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error !== null ? (
        <p role="alert" className="mt-1 text-meta text-danger">{error}</p>
      ) : null}
    </div>
  );
}

function HighlightsBlock({ wsId, uid }: { wsId: string | null; uid: string | null }): React.JSX.Element {
  const { highlights, isPending, failed, request, requesting } = useDayHighlights(wsId, uid);
  React.useEffect(() => {
    if (highlights === null && !isPending && !requesting && !failed) request();
  }, [highlights, isPending, requesting, failed, request]);
  if (isPending && highlights === null) {
    return (
      <div className="flex flex-col gap-2 py-2" aria-label="Cargando destacados">
        {[0, 1].map((index) => (
          <span key={index} aria-hidden="true" className="block h-12 animate-pulse rounded-sm bg-surface-soft" />
        ))}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="py-2">
        <p className="text-body-sm text-muted-foreground">Destacados con IA no disponibles.</p>
        <button
          type="button"
          onClick={request}
          className="mt-1 min-h-11 text-body-sm font-semibold text-mention outline-none interactive"
        >
          Reintentar
        </button>
      </div>
    );
  }
  if (highlights === null || highlights.status === "loading") {
    return <p className="py-2 text-body-sm text-muted-foreground">Buscando lo importante…</p>;
  }
  if (highlights.status === "empty") {
    return <p className="py-2 text-body-sm text-muted-foreground">Sin novedades en tus espacios.</p>;
  }
  if (highlights.status === "unavailable") {
    return <p className="py-2 text-body-sm text-muted-foreground">Destacados con IA no disponibles.</p>;
  }
  return (
    <div className="py-2">
      <p className="whitespace-pre-line text-body-sm text-foreground">{highlights.summary}</p>
      {highlights.deterministic ? (
        <p className="mt-1 text-meta text-muted-foreground">Destacados con IA no disponibles.</p>
      ) : null}
    </div>
  );
}

function SpaceGroup({ group, uid }: { group: TodaySpaceDigest; uid: string }): React.JSX.Element | null {
  const tasks = [...group.overdue, ...group.dueToday];
  // La agenda (eventos) va en la columna izquierda; aquí turnos, tareas, listas
  // y encuestas. Si el espacio no tiene nada de eso, no se pinta.
  if (
    tasks.length === 0 &&
    group.shifts.length === 0 &&
    group.lists.length === 0 &&
    group.polls.length === 0
  ) {
    return null;
  }
  return (
    <div className="mt-4 first:mt-0">
      <p className="px-1 pb-2 text-body-sm font-semibold text-foreground">
        {group.wsEmoji} {group.wsName}
      </p>
      <div className="flex flex-col gap-3">
        {group.shifts.length > 0 ? (
          <Section icon={Repeat} title="Te toca hoy" count={group.shifts.length}>
            <ul>
              {group.shifts.map((shift) => (
                <ShiftRow key={shift.id} shift={shift} />
              ))}
            </ul>
          </Section>
        ) : null}
        {tasks.length > 0 ? (
          <Section icon={ClipboardCheck} title="Tareas" count={tasks.length}>
            <ul>
              {group.overdue.length > 0 ? (
                <li className="pt-1 text-meta font-semibold uppercase text-muted-foreground">
                  Atrasadas ({group.overdue.length})
                </li>
              ) : null}
              {group.overdue.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
              {group.dueToday.length > 0 ? (
                <li className="pt-1 text-meta font-semibold uppercase text-muted-foreground">
                  Vencen hoy ({group.dueToday.length})
                </li>
              ) : null}
              {group.dueToday.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          </Section>
        ) : null}
        {group.lists.length > 0 ? (
          <Section icon={ListChecks} title="Listas pendientes" count={group.lists.length} defaultOpen={false}>
            {group.lists.map((entry) => (
              <PinnedListBlock key={entry.list.id} entry={entry} uid={uid} />
            ))}
          </Section>
        ) : null}
        {group.polls.length > 0 ? (
          <Section icon={BarChart3} title="Encuestas por votar" count={group.polls.length} defaultOpen={false}>
            {group.polls.map((poll) => (
              <PollVoteBlock key={poll.id} poll={poll} />
            ))}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

export function TodayView(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { workspaces, currentWorkspaceId } = useWorkspaces();
  const uid = user?.uid ?? null;
  const spaces = React.useMemo(
    () => workspaces.map((space) => ({ wsId: space.wsId, name: space.name, emoji: space.emoji })),
    [workspaces],
  );
  const { groups, isPending, error, retry } = useTodayDigest(spaces, uid, null);
  const total =
    groups.reduce(
      (sum, group) =>
        sum +
        group.events.length +
        group.dueToday.length +
        group.overdue.length +
        group.shifts.length +
        group.lists.length +
        group.polls.length,
      0,
    );
  const rawLabel = new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  const dateLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);

  if (uid === null) {
    return (
      <EmptyState
        icon={Sunrise}
        title="Inicia sesión para ver tu día"
        description="El resumen diario aparece aquí cuando entras a tu cuenta."
      />
    );
  }
  if (error !== null && groups.length === 0) {
    return <QueryRetry message="No se pudo cargar tu día." onRetry={retry} />;
  }
  if (isPending && groups.length === 0) {
    return (
      <div className="flex flex-col gap-3" aria-label="Cargando tu día">
        {[0, 1, 2].map((index) => (
          <span key={index} aria-hidden="true" className="block h-24 animate-pulse rounded-lg bg-surface-soft" />
        ))}
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          icon={Sunrise}
          title="Nada pendiente hoy"
          description="Sin eventos, turnos, tareas, listas ni encuestas por votar. Buen día para adelantar algo."
        />
        <Section icon={Sparkles} title="Destacados" count={0}>
          <HighlightsBlock wsId={currentWorkspaceId} uid={uid} />
        </Section>
      </div>
    );
  }
  return (
    <div>
      <p className="px-1 pb-1 text-body-sm text-muted-foreground">{dateLabel}</p>
      {/* Móvil: una columna. Escritorio: agenda a la izquierda; tareas, listas y destacados a la derecha. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          {groups.map((group) =>
            group.events.length > 0 ? (
              <div key={`agenda-${group.wsId}`} className="mt-4 first:mt-0">
                <p className="px-1 pb-2 text-body-sm font-semibold text-foreground">
                  {group.wsEmoji} {group.wsName}
                </p>
                <Section icon={CalendarClock} title="Agenda de hoy" count={group.events.length}>
                  <ul>
                    {group.events.map((occurrence) => (
                      <EventRow key={occurrence.occurrenceId} occurrence={occurrence} />
                    ))}
                  </ul>
                </Section>
              </div>
            ) : null,
          )}
          {groups.every((group) => group.events.length === 0) ? (
            <Card className="mt-4 p-4 lg:mt-0">
              <p className="text-body-sm text-muted-foreground">Sin eventos hoy.</p>
            </Card>
          ) : null}
        </div>
        <div>
          {groups.map((group) => (
            <SpaceGroup key={group.wsId} group={group} uid={uid} />
          ))}
          <div className="mt-4">
            <Section icon={Sparkles} title="Destacados" count={0} defaultOpen={false}>
              <HighlightsBlock wsId={currentWorkspaceId} uid={uid} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
