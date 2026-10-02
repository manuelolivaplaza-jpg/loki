"use client";

/**
 * Vista "Turnos" del espacio: quién hace qué y cuándo.
 *
 * Móvil: lista por semana con avatares. Escritorio: grilla de semanas ×
 * tareas. Las ocurrencias previstas salen del motor de recurrencia del cliente
 * (`src/lib/recurring/recurrence.ts`, espejo de las funciones SQL) y, cuando ya
 * existe la tarea de esa fecha, se muestra esa (con su id para abrirla).
 *
 * Aquí no hay nada consultando en bucle: una query por apertura + Realtime
 * mientras la pantalla está montada.
 */

import * as React from "react";
import { CalendarPlus, Check, ChevronLeft, ChevronRight, Handshake, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { QueryRetry } from "@/components/ui/query-retry";
import { Avatar } from "@/components/ui/avatar";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { useMembers } from "@/hooks/use-chat";
import {
  useResolveSwap,
  useSeriesOccurrences,
  useShiftSeries,
  useShiftSwaps,
} from "@/hooks/use-series";
import { SeriesSheet } from "@/components/series/series-sheet";
import { ShiftActionsSheet } from "@/components/series/shift-actions-sheet";
import { describeRotation, plannedOccurrences, toDateKey } from "@/lib/recurring/recurrence";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { Database } from "@/types/supabase";
import type { SeriesItem, SeriesPlanned } from "@/types/recurring";
import { cn } from "@/lib/utils";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

const WEEKS = 4;
/** Tope de ocurrencias previstas por serie (medio año de margen). */
const PLANNED_LIMIT = 40;

function startOfMonday(date: Date): Date {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function dayLabel(date: Date, today: Date): string {
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Mañana";
  const raw = new Intl.DateTimeFormat("es", { weekday: "short" }).format(date).replace(".", "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function shortDay(date: Date): string {
  const raw = new Intl.DateTimeFormat("es", { weekday: "short" }).format(date).replace(".", "");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function MemberAvatar({
  uid,
  name,
  size = 32,
}: {
  uid: string;
  name: string;
  size?: 28 | 32 | 36;
}): React.JSX.Element {
  const color = useAuthorAvatarColor(uid);
  return (
    <Avatar
      size={size}
      color={color}
      initial={(name.trim().charAt(0) || "?").toUpperCase()}
    />
  );
}

type Cell = {
  planned: SeriesPlanned;
  task: TaskRow | null;
  series: SeriesItem;
};

function mergeOccurrences(
  planned: SeriesPlanned[],
  tasks: readonly TaskRow[],
  series: SeriesItem,
): Cell[] {
  const byKey = new Map<string, TaskRow>();
  for (const task of tasks) {
    if (task.series_id === null || task.due_at === null) continue;
    const key = `${task.series_id}|${toDateKey(new Date(task.due_at))}`;
    byKey.set(key, task);
  }
  return planned.map((entry) => ({
    planned: entry,
    task: byKey.get(`${entry.seriesId}|${entry.date}`) ?? null,
    series,
  }));
}

export function ShiftsView(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const uid = user?.uid ?? "";
  const { currentWorkspaceId } = useWorkspaces();
  const wsId = currentWorkspaceId ?? "";
  const membersQuery = useMembers(wsId);
  const series = useShiftSeries(wsId);
  const swapsQuery = useShiftSwaps(wsId, uid === "" ? null : uid);
  const resolveSwap = useResolveSwap();

  const [weekOffset, setWeekOffset] = React.useState(0);
  const [actionsFor, setActionsFor] = React.useState<Cell | null>(null);
  const [editing, setEditing] = React.useState<SeriesItem | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const today = React.useMemo(() => new Date(), []);
  const monday = React.useMemo(() => {
    const base = startOfMonday(today);
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [today, weekOffset]);

  const rangeTo = React.useMemo(() => addDays(monday, WEEKS * 7), [monday]);
  const occurrencesQuery = useSeriesOccurrences(wsId, today, rangeTo);

  const members = React.useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const nameOf = React.useCallback(
    (id: string): string => {
      if (id === uid) return "tú";
      const found = members.find((member) => member.uid === id);
      return found?.displayName ?? "Alguien";
    },
    [members, uid],
  );
  const isMember = React.useCallback(
    (id: string): boolean => members.some((member) => member.uid === id),
    [members],
  );

  const cellsBySeries = React.useMemo(
    () =>
      series.map((item) =>
        mergeOccurrences(
          plannedOccurrences(item, PLANNED_LIMIT, today, isMember).map((planned) => ({
            ...planned,
            assigneeId: isMember(planned.assigneeId) ? planned.assigneeId : "",
          })),
          occurrencesQuery.data ?? [],
          item,
        ),
      ),
    [series, today, isMember, occurrencesQuery.data],
  );

  const weeks = React.useMemo(
    () => Array.from({ length: WEEKS }, (_, index) => addDays(monday, index * 7)),
    [monday],
  );

  const pending = (swapsQuery.data ?? []).filter((swap) => swap.status === "pending");

  if (wsId === "") {
    return (
      <EmptyState
        icon={CalendarPlus}
        title="Elige un espacio"
        description="Los turnos son de cada espacio. Cambia de espacio para verlos."
      />
    );
  }

  const openCell = (cell: Cell): void => {
    setActionsFor(cell);
  };

  async function answer(swapId: string, accept: boolean): Promise<void> {
    setError(null);
    try {
      await resolveSwap.mutateAsync({ swapId, accept });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo resolver el cambio.");
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <div>
          <p className="text-body-sm font-semibold text-foreground">Turnos</p>
          <p className="text-meta text-muted-foreground">
            Quién hace cada cosa y cuándo.
          </p>
        </div>
        <IconButton variant="solid" aria-label="Nueva repetición" onClick={() => setCreating(true)}>
          <Icon icon={CalendarPlus} size={20} />
        </IconButton>
      </div>

      <div className="mt-3 flex items-center justify-between px-2">
        <IconButton
          variant="ghost"
          aria-label="Semanas anteriores"
          disabled={weekOffset <= 0}
          onClick={() => setWeekOffset((value) => value - 1)}
        >
          <Icon icon={ChevronLeft} size={20} />
        </IconButton>
        <p className="text-body-sm text-muted-foreground">
          {new Intl.DateTimeFormat("es", { day: "numeric", month: "long" }).format(monday)}
          {" → "}
          {new Intl.DateTimeFormat("es", { day: "numeric", month: "long" }).format(
            addDays(monday, WEEKS * 7 - 1),
          )}
        </p>
        <IconButton
          variant="ghost"
          aria-label="Semanas siguientes"
          onClick={() => setWeekOffset((value) => value + 1)}
        >
          <Icon icon={ChevronRight} size={20} />
        </IconButton>
      </div>

      {error !== null ? (
        <p role="alert" className="mt-2 px-2 text-meta text-danger">
          {error}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <section aria-label="Cambios pedidos" className="mt-3">
          <Card>
            {pending.map((swap, index) => (
              <React.Fragment key={swap.id}>
                {index > 0 ? <CardDivider /> : null}
                <CardRow minHeight="15">
                  <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground">
                    <Icon icon={Handshake} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium text-foreground">
                      {swap.direction === "incoming"
                        ? `${nameOf(swap.fromUserId)} te pregunta: ¿me cambias el turno?`
                        : `Le pediste a ${nameOf(swap.toUserId)} el cambio`}
                    </span>
                    <span className="block truncate text-meta text-muted-foreground">
                      {swap.seriesTitle}
                      {swap.note !== "" ? ` · ${swap.note}` : ""}
                    </span>
                  </span>
                  {swap.direction === "incoming" ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label="Aceptar el cambio"
                        onClick={() => void answer(swap.id, true)}
                        className="flex h-10 items-center gap-1 rounded-full bg-foreground px-3 text-body-sm font-semibold text-background outline-none interactive dark:bg-white dark:text-black"
                      >
                        <Icon icon={Check} size={20} />
                        Sí
                      </button>
                      <button
                        type="button"
                        aria-label="Rechazar el cambio"
                        onClick={() => void answer(swap.id, false)}
                        className="h-10 rounded-full bg-surface-soft px-3 text-body-sm font-semibold text-foreground outline-none interactive"
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <span className="shrink-0 text-meta text-muted-foreground">Esperando</span>
                  )}
                </CardRow>
              </React.Fragment>
            ))}
          </Card>
        </section>
      ) : null}

      {series.length === 0 ? (
        <Card className="mt-3">
          <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
            No hay turnos rotativos en este espacio. Repite una tarea o pide a Loki
            algo como “cada domingo alguien distinto riega las plantas”.
          </p>
          <div className="px-4 pb-4">
            <Button type="button" onClick={() => setCreating(true)} className="w-full">
              <Icon icon={CalendarPlus} size={20} />
              Crear repetición
            </Button>
          </div>
        </Card>
      ) : null}

      {series.length > 0 ? (
        <>
          {/* Móvil: una lista por semana, con avatares. */}
          <div className="mt-3 flex flex-col gap-3 lg:hidden">
            {weeks.map((weekStart) => {
              const cells = cellsBySeries
                .flat()
                .filter((cell) => {
                  const date = fromKey(cell.planned.date);
                  return date >= weekStart && date < addDays(weekStart, 7);
                });
              if (cells.length === 0) return null;
              return (
                <section key={weekStart.toISOString()} aria-label={`Semana del ${dayLabel(weekStart, today)}`}>
                  <p className="px-2 pb-1 text-meta font-semibold uppercase text-muted-foreground">
                    Semana {dayLabel(weekStart, today)} · {weekStart.getDate()}/{weekStart.getMonth() + 1}
                  </p>
                  <Card>
                    {cells.map((cell, index) => {
                      const date = fromKey(cell.planned.date);
                      const name = cell.planned.assigneeId === "" ? "" : nameOf(cell.planned.assigneeId);
                      return (
                        <React.Fragment key={`${cell.planned.seriesId}-${cell.planned.date}`}>
                          {index > 0 ? <CardDivider /> : null}
                          <button
                            type="button"
                            onClick={() => openCell(cell)}
                            className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left outline-none interactive"
                          >
                            <span className="w-12 shrink-0 text-body-sm font-semibold text-foreground">
                              {shortDay(date)} {date.getDate()}
                            </span>
                            {cell.planned.assigneeId !== "" ? (
                              <MemberAvatar uid={cell.planned.assigneeId} name={name} />
                            ) : (
                              <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-soft text-foreground">
                                <Icon icon={Repeat} size={20} />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body-sm font-medium text-foreground">
                                {cell.series.title}
                              </span>
                              <span className="block truncate text-meta text-muted-foreground">
                                {name === "" ? "Sin responsable" : name}
                                {cell.task !== null && cell.task.status === "done"
                                  ? " · hecha"
                                  : ""}
                              </span>
                            </span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </Card>
                </section>
              );
            })}
            {cellsBySeries.flat().length === 0 ? (
              <Card>
                <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
                  No hay turnos en estas semanas.
                </p>
              </Card>
            ) : null}
          </div>

          {/* Escritorio: grilla semanas × tareas. */}
          <div className="mt-3 hidden lg:block">
            <div
              role="table"
              aria-label="Rotación por semana"
              className="overflow-hidden rounded-2xl border border-divider bg-background"
            >
              <div role="row" className="grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] border-b border-divider bg-surface-soft/60">
                <span className="px-3 py-2 text-meta font-semibold uppercase text-muted-foreground">
                  Tarea
                </span>
                {weeks.map((weekStart) => (
                  <span key={weekStart.toISOString()} className="px-3 py-2 text-meta font-semibold text-muted-foreground">
                    {dayLabel(weekStart, today)} {weekStart.getDate()}/{weekStart.getMonth() + 1}
                  </span>
                ))}
              </div>
              {series.map((item, seriesIndex) => {
                const cells = cellsBySeries[seriesIndex] ?? [];
                return (
                  <div
                    key={item.id}
                    role="row"
                    className="grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] border-b border-divider last:border-b-0"
                  >
                    <span className="min-w-0 px-3 py-3">
                      <span className="block truncate text-body-sm font-semibold text-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-meta text-muted-foreground">
                        {describeRotation(item.rotation, nameOf, uid)}
                      </span>
                    </span>
                    {weeks.map((weekStart) => (
                      <span key={weekStart.toISOString()} className="min-w-0 border-l border-divider px-2 py-3">
                        {cells
                          .filter((cell) => {
                            const date = fromKey(cell.planned.date);
                            return date >= weekStart && date < addDays(weekStart, 7);
                          })
                          .map((cell) => {
                            const name =
                              cell.planned.assigneeId === ""
                                ? ""
                                : nameOf(cell.planned.assigneeId);
                            const done =
                              cell.task !== null && cell.task.status === "done";
                            return (
                              <button
                                key={cell.planned.date}
                                type="button"
                                onClick={() => openCell(cell)}
                                className={cn(
                                  "mb-1 flex min-h-10 w-full items-center gap-2 rounded-sm px-2 text-left outline-none interactive",
                                  done ? "opacity-60" : "bg-surface-soft",
                                )}
                              >
                                {cell.planned.assigneeId !== "" ? (
                                  <MemberAvatar uid={cell.planned.assigneeId} name={name} size={28} />
                                ) : null}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-meta font-medium text-foreground">
                                    {fromKey(cell.planned.date).getDate()}/{fromKey(cell.planned.date).getMonth() + 1}
                                  </span>
                                  <span className="block truncate text-meta text-muted-foreground">
                                    {name === "" ? "Sin responsable" : name}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <section aria-label="Series del espacio" className="mt-4">
            <p className="px-2 pb-1 text-body-sm font-semibold text-foreground">
              Repeticiones del espacio
            </p>
            <Card>
              {series.map((item, index) => (
                <React.Fragment key={item.id}>
                  {index > 0 ? <CardDivider /> : null}
                  <CardRow minHeight="15">
                    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground">
                      <Icon icon={Repeat} size={20} />
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditing(item)}
                      className="min-w-0 flex-1 text-left outline-none"
                    >
                      <span className="block truncate text-body-sm font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-meta text-muted-foreground">
                        {describeRotation(item.rotation, nameOf, uid)}
                        {item.endsOn !== null ? ` · hasta el ${item.endsOn}` : ""}
                      </span>
                    </button>
                  </CardRow>
                </React.Fragment>
              ))}
            </Card>
          </section>
        </>
      ) : null}

      {occurrencesQuery.isError ? (
        <QueryRetry
          message="No se pudieron cargar los turnos."
          onRetry={() => void occurrencesQuery.refetch()}
        />
      ) : null}

      <ShiftActionsSheet
        open={actionsFor !== null}
        wsId={wsId}
        uid={uid}
        series={actionsFor?.series ?? null}
        taskId={actionsFor?.task?.id ?? null}
        dateKey={actionsFor?.planned.date ?? toDateKey(new Date())}
        assigneeId={actionsFor?.planned.assigneeId ?? ""}
        onClose={() => setActionsFor(null)}
        onEditSeries={(item) => setEditing(item)}
      />

      <SeriesSheet
        open={creating || editing !== null}
        wsId={wsId}
        uid={uid}
        series={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

/** "YYYY-MM-DD" → Date local (medianoche). */
function fromKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}