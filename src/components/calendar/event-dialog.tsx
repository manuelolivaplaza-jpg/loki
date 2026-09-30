"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { useMembers } from "@/hooks/use-chat";
import {
  useCreateEvent,
  useDeleteEvent,
  useProjects,
  useUpdateEvent,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import { AVATAR_COLORS } from "@/types/models";
import type { EventItem, EventRecurrence } from "@/types/organizer";
import { cn } from "@/lib/utils";

const REMINDER_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 1440, label: "1 día" },
];

const RECURRENCE_OPTIONS: readonly { value: "" | EventRecurrence; label: string }[] = [
  { value: "", label: "No se repite" },
  { value: "daily", label: "Todos los días" },
  { value: "weekly", label: "Todas las semanas" },
  { value: "monthly", label: "Todos los meses" },
];

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function toInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseInputValue(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function defaultRange(preset: Date | null): { start: Date; end: Date } {
  const start = preset ?? new Date(Date.now() + 3_600_000);
  start.setMinutes(0, 0, 0);
  return { start, end: new Date(start.getTime() + 3_600_000) };
}

export function EventDialog({
  open,
  event,
  presetStart,
  onClose,
}: {
  open: boolean;
  event: EventItem | null;
  presetStart: Date | null;
  onClose: () => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const membersQuery = useMembers(currentWorkspaceId);
  const projectsQuery = useProjects(currentWorkspaceId);
  const createEvent = useCreateEvent(currentWorkspaceId);
  const updateEvent = useUpdateEvent();
  const deleteEvent = useDeleteEvent();

  const initial: {
    title: string;
    description: string;
    start: string;
    end: string;
    allDay: boolean;
    location: string;
    color: string;
    projectId: string;
    attendees: string[];
    reminders: number[];
    recurrence: "" | EventRecurrence;
  } = React.useMemo(() => {
    if (event !== null) {
      return {
        title: event.title,
        description: event.description,
        start: toInputValue(event.startsAt.toDate()),
        end: toInputValue(event.endsAt.toDate()),
        allDay: event.allDay,
        location: event.location,
        color: event.color,
        projectId: event.projectId ?? "",
        attendees: event.attendees,
        reminders: event.reminderMinutes,
        recurrence: event.recurrence ?? "",
      };
    }
    const range = defaultRange(presetStart);
    return {
      title: "",
      description: "",
      start: toInputValue(range.start),
      end: toInputValue(range.end),
      allDay: false,
      location: "",
      color: AVATAR_COLORS[0]?.value ?? "#1d9bf0",
      projectId: "",
      attendees: [] as string[],
      reminders: [] as number[],
      recurrence: "" as "" | EventRecurrence,
    };
  }, [event, presetStart]);

  const [title, setTitle] = React.useState(initial.title);
  const [description, setDescription] = React.useState(initial.description);
  const [start, setStart] = React.useState(initial.start);
  const [end, setEnd] = React.useState(initial.end);
  const [allDay, setAllDay] = React.useState(initial.allDay);
  const [location, setLocation] = React.useState(initial.location);
  const [color, setColor] = React.useState(initial.color);
  const [projectId, setProjectId] = React.useState(initial.projectId);
  const [attendees, setAttendees] = React.useState<string[]>(initial.attendees);
  const [reminders, setReminders] = React.useState<number[]>(initial.reminders);
  const [recurrence, setRecurrence] = React.useState<"" | EventRecurrence>(initial.recurrence);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTitle(initial.title);
    setDescription(initial.description);
    setStart(initial.start);
    setEnd(initial.end);
    setAllDay(initial.allDay);
    setLocation(initial.location);
    setColor(initial.color);
    setProjectId(initial.projectId);
    setAttendees(initial.attendees);
    setReminders(initial.reminders);
    setRecurrence(initial.recurrence);
    setError(null);
    setConfirmDelete(false);
  }, [open, initial]);

  const saving = createEvent.isPending || updateEvent.isPending;

  function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (user === null || currentWorkspaceId === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    const startsAt = parseInputValue(start);
    const endsAt = parseInputValue(end);
    if (startsAt === null || endsAt === null) {
      setError("Revisa las fechas del evento.");
      return;
    }
    setError(null);
    try {
      if (event === null) {
        await createEvent.mutateAsync({
          uid: user.uid,
          input: {
            title,
            description,
            startsAt,
            endsAt,
            allDay,
            location,
            color,
            projectId: projectId === "" ? null : projectId,
            attendees,
            reminderMinutes: reminders,
            recurrence: recurrence === "" ? null : recurrence,
          },
        });
      } else {
        await updateEvent.mutateAsync({
          id: event.id,
          patch: {
            title,
            description,
            startsAt,
            endsAt,
            allDay,
            location,
            color,
            projectId: projectId === "" ? null : projectId,
            attendees,
            reminderMinutes: reminders,
            recurrence: recurrence === "" ? null : recurrence,
          },
        });
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el evento.");
    }
  }

  async function handleDelete(): Promise<void> {
    if (event === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    try {
      await deleteEvent.mutateAsync(event.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el evento.");
    }
  }

  const members = membersQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={event === null ? "Crear evento" : "Editar evento"}>
        <DialogTitle>{event === null ? "Nuevo evento" : "Editar evento"}</DialogTitle>
        <DialogDescription>Cambios visibles para todo el espacio.</DialogDescription>
        <form onSubmit={(formEvent) => void handleSubmit(formEvent)} className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <div>
            <label htmlFor="event-title" className={labelClassName}>
              Título
            </label>
            <input
              id="event-title"
              name="title"
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(formEvent) => setTitle(formEvent.target.value)}
              placeholder="p. ej. Cena familiar"
              className={inputClassName}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="event-start" className={labelClassName}>
                Inicio
              </label>
              <input
                id="event-start"
                name="start"
                type="datetime-local"
                required
                value={start}
                onChange={(formEvent) => setStart(formEvent.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="event-end" className={labelClassName}>
                Fin
              </label>
              <input
                id="event-end"
                name="end"
                type="datetime-local"
                required
                value={end}
                onChange={(formEvent) => setEnd(formEvent.target.value)}
                className={inputClassName}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Checkbox checked={allDay} onCheckedChange={setAllDay} label="Todo el día" />
            <span className="text-body-sm text-muted-foreground">Todo el día</span>
          </div>
          <div>
            <label htmlFor="event-location" className={labelClassName}>
              Lugar
            </label>
            <input
              id="event-location"
              name="location"
              type="text"
              maxLength={120}
              value={location}
              onChange={(formEvent) => setLocation(formEvent.target.value)}
              placeholder="Opcional"
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="event-description" className={labelClassName}>
              Descripción
            </label>
            <textarea
              id="event-description"
              name="description"
              rows={2}
              value={description}
              onChange={(formEvent) => setDescription(formEvent.target.value)}
              placeholder="Opcional"
              className={`${inputClassName} min-h-11 py-3`}
            />
          </div>
          <div>
            <span id="event-color-label" className={labelClassName}>
              Color
            </span>
            <div role="radiogroup" aria-labelledby="event-color-label" className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((option) => {
                const selected = color === option.value;
                return (
                  <label
                    key={option.value}
                    className="cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-accent"
                  >
                    <input
                      type="radio"
                      name="color"
                      value={option.value}
                      checked={selected}
                      onChange={() => setColor(option.value)}
                      aria-label={option.name}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      style={{ backgroundColor: option.value }}
                      className={cn(
                        "block h-9 w-9 rounded-full",
                        selected && "ring-2 ring-accent ring-offset-2 ring-offset-background",
                      )}
                    />
                  </label>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor="event-project" className={labelClassName}>
              Proyecto
            </label>
            <select
              id="event-project"
              name="project"
              value={projectId}
              onChange={(formEvent) => setProjectId(formEvent.target.value)}
              className={inputClassName}
            >
              <option value="">Sin proyecto</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.emoji} {project.name}
                </option>
              ))}
            </select>
          </div>
          {members.length > 0 ? (
            <div>
              <span id="event-attendees-label" className={labelClassName}>
                Asistentes
              </span>
              <div role="group" aria-labelledby="event-attendees-label" className="flex flex-col gap-2">
                {members.map((member) => (
                  <div key={member.uid} className="flex items-center gap-3">
                    <Checkbox
                      checked={attendees.includes(member.uid)}
                      onCheckedChange={() => setAttendees((current) => toggle(current, member.uid))}
                      label={member.displayName}
                    />
                    <span className="text-body-sm text-foreground">{member.displayName}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <span id="event-reminders-label" className={labelClassName}>
              Recordatorios
            </span>
            <div role="group" aria-labelledby="event-reminders-label" className="flex flex-wrap gap-2">
              {REMINDER_OPTIONS.map((option) => {
                const active = reminders.includes(option.minutes);
                return (
                  <button
                    key={option.minutes}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setReminders((current) => toggle(current, option.minutes))}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-body-sm outline-none interactive",
                      active ? "bg-foreground font-semibold text-background dark:bg-white dark:text-black" : "bg-surface-soft text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor="event-recurrence" className={labelClassName}>
              Repetición
            </label>
            <select
              id="event-recurrence"
              name="recurrence"
              value={recurrence}
              onChange={(formEvent) => setRecurrence(formEvent.target.value as "" | EventRecurrence)}
              className={inputClassName}
            >
              {RECURRENCE_OPTIONS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? "Guardando…" : event === null ? "Crear evento" : "Guardar cambios"}
          </Button>
          {event !== null ? (
            <Button
              type="button"
              variant="secondary"
              disabled={deleteEvent.isPending}
              onClick={() => void handleDelete()}
              className="w-full"
            >
              {confirmDelete ? "Toca de nuevo para eliminar" : "Eliminar evento"}
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
