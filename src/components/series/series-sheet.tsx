"use client";

/**
 * Hoja de "Repetir" y "Turno rotativo".
 *
 * Desde la hoja de tarea ("Repetir…" / "Turno rotativo…") crea una serie con la
 * tarea como plantilla. Abierta sobre una serie existente, la edita por alcance
 * ("solo esta" / "esta y las siguientes" / "toda la serie"), igual que un
 * calendario.
 *
 * Las ocurrencias las genera la base por eventos; aquí solo se escribe la
 * serie (insert) o su alcance (RPC `edit_task_series` / `delete_task_series`).
 */

import * as React from "react";
import { ArrowDown, ArrowUp, CalendarPlus, Repeat, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { RecurrencePicker } from "@/components/series/recurrence-picker";
import { useMembers } from "@/hooks/use-chat";
import { useProjects } from "@/hooks/use-organizer";
import {
  useCreateSeries,
  useDeleteSeries,
  useEditSeries,
  useSeriesUsage,
} from "@/hooks/use-series";
import { describeRule, toDateKey } from "@/lib/recurring/recurrence";
import { deviceTimezone } from "@/lib/data/daily-digest";
import type { WorkspaceMember } from "@/types/models";
import type { TaskPriority } from "@/types/organizer";
import type { SeriesItem, SeriesPatch, SeriesRule, SeriesScope } from "@/types/recurring";
import { DEFAULT_SERIES_RULE } from "@/types/recurring";
import { cn } from "@/lib/utils";

const PRIORITY_OPTIONS: readonly { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Alta" },
];

const SCOPE_LABELS: readonly { value: SeriesScope; label: string }[] = [
  { value: "this", label: "Solo esta" },
  { value: "following", label: "Esta y las siguientes" },
  { value: "all", label: "Toda la serie" },
];

/** Plantilla que llega desde la hoja de tarea. */
export type SeriesTemplate = {
  projectId: string;
  title: string;
  notes?: string;
  priority?: TaskPriority;
  /** Fecha/hora de la tarea: propone la primera ocurrencia. */
  dueAt?: Date | null;
};

function hhmm(date: Date | null, fallback: string): string {
  if (date === null) return fallback;
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initialDate(date: Date | null): string {
  return toDateKey(date ?? new Date());
}

function MemberRow({
  member,
  self,
  position,
  total,
  onToggle,
  onMove,
}: {
  member: WorkspaceMember;
  self: boolean;
  /** -1 = no está en la rotación. */
  position: number;
  total: number;
  onToggle: () => void;
  onMove: (delta: number) => void;
}): React.JSX.Element {
  const inRotation = position >= 0;
  return (
    <div className="flex items-center gap-2 py-1">
      <Checkbox
        checked={inRotation}
        onCheckedChange={onToggle}
        label={`${member.displayName}${self ? " (yo)" : ""}`}
      />
      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
        {member.displayName}
        {self ? " (yo)" : ""}
      </span>
      {inRotation ? (
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-soft text-meta font-semibold text-foreground"
          >
            {position + 1}
          </span>
          <button
            type="button"
            aria-label={`Subir a ${member.displayName} en la rotación`}
            disabled={position === 0}
            onClick={() => onMove(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-40"
          >
            <Icon icon={ArrowUp} size={20} />
          </button>
          <button
            type="button"
            aria-label={`Bajar a ${member.displayName} en la rotación`}
            disabled={position === total - 1}
            onClick={() => onMove(1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-40"
          >
            <Icon icon={ArrowDown} size={20} />
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function SeriesSheet({
  open,
  wsId,
  uid,
  template,
  series,
  taskId,
  intent = "repeat",
  onClose,
}: {
  open: boolean;
  wsId: string;
  uid: string;
  /** Plantilla al crear (null = crear vacía). */
  template?: SeriesTemplate | null;
  /** Serie existente = editar (null = crear). */
  series?: SeriesItem | null;
  /** Ocurrencia sobre la que se actúa al editar por alcance. */
  taskId?: string | null;
  /** Punto de entrada: "Repetir" o "Turno rotativo" (solo el texto y el orden). */
  intent?: "repeat" | "rotation";
  onClose: () => void;
}): React.JSX.Element {
  const editing = series !== null && series !== undefined;
  const membersQuery = useMembers(editing ? series?.workspaceId ?? wsId : wsId);
  const projectsQuery = useProjects(editing ? series?.workspaceId ?? wsId : wsId);
  const usageQuery = useSeriesUsage(editing ? series?.workspaceId ?? wsId : wsId);
  const createSeries = useCreateSeries(editing ? null : wsId);
  const editSeries = useEditSeries();
  const deleteSeries = useDeleteSeries();

  const projects = (projectsQuery.data ?? []).filter((item) => item.status === "active");
  // Sin proyecto dicho (p. ej. "Nueva repetición" en Turnos): la Bandeja del
  // espacio o el primer proyecto activo.
  const defaultProjectId = React.useMemo(() => {
    const inbox = projects.find((item) => item.isSystem);
    return (inbox ?? projects[0])?.id ?? "";
  }, [projects]);

  const [title, setTitle] = React.useState(series?.title ?? template?.title ?? "");
  const [notes, setNotes] = React.useState(series?.notes ?? template?.notes ?? "");
  const [priority, setPriority] = React.useState<TaskPriority>(
    series?.priority ?? template?.priority ?? "normal",
  );
  const [projectId, setProjectId] = React.useState(
    series?.projectId ?? template?.projectId ?? "",
  );
  const [rule, setRule] = React.useState<SeriesRule>(series?.rule ?? DEFAULT_SERIES_RULE);
  const [startDate, setStartDate] = React.useState(
    series?.startDate ?? initialDate(template?.dueAt ?? null),
  );
  const [timeOfDay, setTimeOfDay] = React.useState(
    series?.timeOfDay ?? hhmm(template?.dueAt ?? null, "09:00"),
  );
  const [remindTime, setRemindTime] = React.useState(series?.remindTime ?? "09:00");
  const [endsOn, setEndsOn] = React.useState<string | null>(series?.endsOn ?? null);
  const [rotation, setRotation] = React.useState<string[]>(
    series?.rotation ?? (intent === "rotation" ? [uid] : []),
  );
  const [scope, setScope] = React.useState<SeriesScope>(taskId ? "following" : "all");
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTitle(series?.title ?? template?.title ?? "");
    setNotes(series?.notes ?? template?.notes ?? "");
    setPriority(series?.priority ?? template?.priority ?? "normal");
    setProjectId(series?.projectId ?? template?.projectId ?? defaultProjectId);
    setRule(series?.rule ?? DEFAULT_SERIES_RULE);
    setStartDate(series?.startDate ?? initialDate(template?.dueAt ?? null));
    setTimeOfDay(series?.timeOfDay ?? hhmm(template?.dueAt ?? null, "09:00"));
    setRemindTime(series?.remindTime ?? "09:00");
    setEndsOn(series?.endsOn ?? null);
    setRotation(series?.rotation ?? (intent === "rotation" ? [uid] : []));
    setScope(taskId !== null && taskId !== undefined ? "following" : "all");
    setError(null);
    setConfirmDelete(false);
  }, [open, series, template, taskId, intent, uid, defaultProjectId]);

  const members = membersQuery.data ?? [];
  const saving = createSeries.isPending || editSeries.isPending;
  const usage = usageQuery.data ?? null;
  const atLimit = usage !== null && !editing && usage.active >= usage.limit;

  function toggleMember(uidValue: string): void {
    setRotation((current) =>
      current.includes(uidValue)
        ? current.filter((value) => value !== uidValue)
        : [...current, uidValue],
    );
  }

  function moveMember(uidValue: string, delta: number): void {
    setRotation((current) => {
      const index = current.indexOf(uidValue);
      const next = index + delta;
      if (index === -1 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      const [moved] = copy.splice(index, 1);
      if (moved === undefined) return current;
      copy.splice(next, 0, moved);
      return copy;
    });
  }

  function patch(): SeriesPatch {
    return {
      title: title.trim(),
      notes,
      priority,
      recurrence_kind: rule.kind,
      recurrence_interval: rule.interval,
      recurrence_unit: rule.unit,
      weekdays: rule.weekdays,
      month_day: rule.monthDay,
      month_week: rule.monthWeek,
      month_weekday: rule.monthWeekday,
      start_date: startDate,
      timeOfDay,
      remindTime,
      timezone: series?.timezone ?? deviceTimezone(),
      endsOn,
      rotation,
      active: series?.active ?? true,
    };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (title.trim() === "") {
      setError("Ponle un título a la tarea que se repite.");
      return;
    }
    if (rule.kind === "weekly" && rule.weekdays.length === 0) {
      setError("Elige al menos un día de la semana.");
      return;
    }
    if (rule.kind === "monthly" && rule.monthDay === null && rule.monthWeek === null) {
      setError("Elige el día del mes.");
      return;
    }
    try {
      if (editing && series !== null && series !== undefined) {
        await editSeries.mutateAsync({
          seriesId: series.id,
          patch: patch(),
          scope,
          taskId: taskId ?? null,
        });
      } else {
        if (projectId === "") throw new Error("Elige en qué proyecto va la serie.");
        await createSeries.mutateAsync({
          uid,
          input: {
            projectId,
            title,
            notes,
            priority,
            rule,
            startDate,
            timeOfDay,
            remindTime,
            timezone: deviceTimezone(),
            endsOn,
            rotation,
          },
        });
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    }
  }

  async function handleDelete(): Promise<void> {
    if (!editing || series === null || series === undefined) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    try {
      await deleteSeries.mutateAsync({
        seriesId: series.id,
        scope,
        taskId: taskId ?? null,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo borrar.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={editing ? "Editar repetición" : "Tarea que se repite"}>
        <DialogTitle>
          {editing ? "Editar repetición" : rotation.length > 0 ? "Turno rotativo" : "Repetir"}
        </DialogTitle>
        <DialogDescription>
          {rotation.length > 0
            ? "Cada vez le toca a alguien distinto, en el orden que elijas."
            : "Cada vez se crea la misma tarea. Elige cada cuánto."}
        </DialogDescription>
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto"
        >
          <div>
            <label htmlFor="series-title" className={labelClassName}>
              Título
            </label>
            <input
              id="series-title"
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={inputClassName}
            />
          </div>

          <RecurrencePicker
            rule={rule}
            startDate={startDate}
            endsOn={endsOn}
            onChange={setRule}
            onStartDateChange={setStartDate}
            onEndsOnChange={setEndsOn}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="series-time" className={labelClassName}>
                A qué hora
              </label>
              <input
                id="series-time"
                type="time"
                value={timeOfDay}
                onChange={(event) => setTimeOfDay(event.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="series-remind" className={labelClassName}>
                Aviso a las
              </label>
              <input
                id="series-remind"
                type="time"
                value={remindTime}
                onChange={(event) => setRemindTime(event.target.value)}
                className={inputClassName}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="series-priority" className={labelClassName}>
                Prioridad
              </label>
              <select
                id="series-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TaskPriority)}
                className={inputClassName}
              >
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {projects.length > 1 ? (
              <div>
                <label htmlFor="series-project" className={labelClassName}>
                  Proyecto
                </label>
                <select
                  id="series-project"
                  value={projectId}
                  disabled={editing}
                  onChange={(event) => setProjectId(event.target.value)}
                  className={inputClassName}
                >
                  <option value="">Elige proyecto…</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.emoji} {project.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          <div>
            <span className={labelClassName}>
              Turnos rotativos (toca a alguien distinto cada vez)
            </span>
            <p className="mb-1 text-meta text-muted-foreground">
              Elige a quién y en qué orden. Sin marcar a nadie, la tarea se repite
              sin responsable fijo.
            </p>
            <div className="flex flex-col" role="group" aria-label="Rotación de turnos">
              {members.map((member) => (
                <MemberRow
                  key={member.uid}
                  member={member}
                  self={member.uid === uid}
                  position={rotation.indexOf(member.uid)}
                  total={rotation.length}
                  onToggle={() => toggleMember(member.uid)}
                  onMove={(delta) => moveMember(member.uid, delta)}
                />
              ))}
              {members.length === 0 ? (
                <p className="text-body-sm text-muted-foreground">
                  Este espacio no tiene miembros todavía.
                </p>
              ) : null}
            </div>
          </div>

          {editing && taskId ? (
            <div>
              <span className={labelClassName}>Aplicar a</span>
              <div role="radiogroup" aria-label="Alcance del cambio" className="mt-1 flex rounded-full bg-surface-soft p-1">
                {SCOPE_LABELS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={scope === option.value}
                    onClick={() => setScope(option.value)}
                    className={cn(
                      "h-10 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                      scope === option.value
                        ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                        : "text-muted-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-meta text-muted-foreground">
                {scope === "this"
                  ? "Esta occurrence se separa y deja de repetirse."
                  : scope === "following"
                    ? "Se rehacen las que todavía no están hechas."
                    : "La serie vuelve a empezar desde la primera vez."}
              </p>
            </div>
          ) : null}

          {atLimit ? (
            <p role="alert" className="text-meta text-danger">
              Este espacio llegó a su límite de {usage?.limit} series activas. Pausa o
              borra alguna para crear otra.
            </p>
          ) : null}
          {usage !== null && !editing ? (
            <p className="text-meta text-muted-foreground">
              {usage.active} de {usage.limit} series activas en este espacio.
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={saving || atLimit} className="w-full">
            {saving
              ? "Guardando…"
              : editing
                ? "Guardar cambios"
                : rotation.length > 0
                  ? "Crear turno rotativo"
                  : "Crear repetición"}
          </Button>
          {editing ? (
            <Button
              type="button"
              variant="secondary"
              disabled={deleteSeries.isPending}
              onClick={() => void handleDelete()}
              className="w-full"
            >
              {confirmDelete ? "Toca de nuevo para borrar" : "Borrar"}
            </Button>
          ) : null}

          <p className="flex items-start gap-2 text-meta text-muted-foreground">
            {rotation.length > 0 ? (
              <Icon icon={Users} size={20} className="mt-0.5 shrink-0" />
            ) : (
              <Icon icon={CalendarPlus} size={20} className="mt-0.5 shrink-0" />
            )}
            <span>
              {describeRule(rule)}
              {rotation.length > 0
                ? ` · turnos entre ${rotation.length} ${rotation.length === 1 ? "persona" : "personas"}`
                : ""}
              . La siguiente tarea se crea cuando termina esta o cuando llega su
              momento; nunca se crean cientos de tareas futuras.
            </span>
          </p>
          <p className="flex items-start gap-2 text-meta text-muted-foreground">
            <Icon icon={Repeat} size={20} className="mt-0.5 shrink-0" />
            <span>
              Zona horaria {series?.timezone ?? deviceTimezone()}: las fechas siguen tu
              horario de verano.
            </span>
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}