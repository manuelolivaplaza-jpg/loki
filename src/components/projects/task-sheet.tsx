"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { useMembers } from "@/hooks/use-chat";
import {
  useCreateTask,
  useDeleteTask,
  useTasks,
  useUpdateTask,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { TaskItem, TaskPriority, TaskStatus } from "@/types/organizer";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: readonly { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "Por hacer" },
  { value: "doing", label: "En curso" },
  { value: "done", label: "Hecha" },
];

const PRIORITY_OPTIONS: readonly { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Alta" },
];

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function toInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseInputValue(value: string): Date | null {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type TaskSheetInitial = {
  title?: string;
  notes?: string;
  assigneeIds?: string[];
  dueAt?: Date | null;
  reminderAt?: Date | null;
};

export function TaskSheet({
  open,
  projectId,
  task,
  initial,
  onCreated,
  onClose,
}: {
  open: boolean;
  projectId: string;
  /** Null = crear; con tarea = editar. */
  task: TaskItem | null;
  /** Prefill al convertir un mensaje (solo crear). */
  initial?: TaskSheetInitial;
  /** Al crear: devuelve el id (para el vínculo con el mensaje). */
  onCreated?: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const membersQuery = useMembers(currentWorkspaceId);
  const tasksQuery = useTasks(projectId);
  const createTask = useCreateTask(projectId, currentWorkspaceId);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const [title, setTitle] = React.useState(task?.title ?? "");
  const [notes, setNotes] = React.useState(task?.notes ?? "");
  const [status, setStatus] = React.useState<TaskStatus>(task?.status ?? "todo");
  const [priority, setPriority] = React.useState<TaskPriority>(task?.priority ?? "normal");
  const [assignees, setAssignees] = React.useState<string[]>(task?.assigneeIds ?? []);
  const [due, setDue] = React.useState(task?.dueAt ? toInputValue(task.dueAt.toDate()) : "");
  const [reminder, setReminder] = React.useState(
    task?.reminderAt ? toInputValue(task.reminderAt.toDate()) : "",
  );
  const [subtaskTitle, setSubtaskTitle] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? initial?.title ?? "");
    setNotes(task?.notes ?? initial?.notes ?? "");
    setStatus(task?.status ?? "todo");
    setPriority(task?.priority ?? "normal");
    setAssignees(task?.assigneeIds ?? initial?.assigneeIds ?? []);
    setDue(
      task?.dueAt
        ? toInputValue(task.dueAt.toDate())
        : initial?.dueAt != null
          ? toInputValue(initial.dueAt)
          : "",
    );
    setReminder(
      task?.reminderAt
        ? toInputValue(task.reminderAt.toDate())
        : initial?.reminderAt != null
          ? toInputValue(initial.reminderAt)
          : "",
    );
    setSubtaskTitle("");
    setError(null);
    setConfirmDelete(false);
  }, [open, task, initial]);

  const saving = createTask.isPending || updateTask.isPending;
  const members = membersQuery.data ?? [];
  const subtasks = React.useMemo(
    () =>
      task === null
        ? []
        : (tasksQuery.data ?? []).filter((item) => item.parentTaskId === task.id),
    [task, tasksQuery.data],
  );

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (user === null || currentWorkspaceId === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    try {
      if (task === null) {
        const id = await createTask.mutateAsync({
          uid: user.uid,
          input: {
            title,
            notes,
            priority,
            assigneeIds: assignees,
            dueAt: parseInputValue(due),
            reminderAt: parseInputValue(reminder),
          },
        });
        onCreated?.(id);
      } else {
        await updateTask.mutateAsync({
          id: task.id,
          patch: {
            title,
            notes,
            status,
            priority,
            assigneeIds: assignees,
            dueAt: parseInputValue(due),
            reminderAt: parseInputValue(reminder),
          },
        });
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la tarea.");
    }
  }

  async function handleDelete(): Promise<void> {
    if (task === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    try {
      await deleteTask.mutateAsync(task.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la tarea.");
    }
  }

  async function handleAddSubtask(): Promise<void> {
    const text = subtaskTitle.trim();
    if (text === "" || task === null || user === null || currentWorkspaceId === null) return;
    setError(null);
    try {
      await createTask.mutateAsync({
        uid: user.uid,
        input: { title: text, parentTaskId: task.id },
      });
      setSubtaskTitle("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear la subtarea.");
    }
  }

  async function toggleSubtask(subtask: TaskItem): Promise<void> {
    setError(null);
    try {
      await updateTask.mutateAsync({
        id: subtask.id,
        patch: { status: subtask.status === "done" ? "todo" : "done" },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la subtarea.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={task === null ? "Nueva tarea" : "Editar tarea"}>
        <DialogTitle>{task === null ? "Nueva tarea" : "Tarea"}</DialogTitle>
        <DialogDescription>Visible para todo el espacio.</DialogDescription>
        <form onSubmit={(formEvent) => void handleSubmit(formEvent)} className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <div>
            <label htmlFor="task-title" className={labelClassName}>
              Título
            </label>
            <input
              id="task-title"
              name="title"
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(formEvent) => setTitle(formEvent.target.value)}
              placeholder="p. ej. Comprar pintura"
              className={inputClassName}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="task-status" className={labelClassName}>
                Estado
              </label>
              <select
                id="task-status"
                name="status"
                value={status}
                onChange={(formEvent) => setStatus(formEvent.target.value as TaskStatus)}
                className={inputClassName}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="task-priority" className={labelClassName}>
                Prioridad
              </label>
              <select
                id="task-priority"
                name="priority"
                value={priority}
                onChange={(formEvent) => setPriority(formEvent.target.value as TaskPriority)}
                className={inputClassName}
              >
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="task-due" className={labelClassName}>
                Vence
              </label>
              <input
                id="task-due"
                name="due"
                type="datetime-local"
                value={due}
                onChange={(formEvent) => setDue(formEvent.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="task-reminder" className={labelClassName}>
                Recordatorio
              </label>
              <input
                id="task-reminder"
                name="reminder"
                type="datetime-local"
                value={reminder}
                onChange={(formEvent) => setReminder(formEvent.target.value)}
                className={inputClassName}
              />
            </div>
          </div>
          <div>
            <label htmlFor="task-notes" className={labelClassName}>
              Notas
            </label>
            <textarea
              id="task-notes"
              name="notes"
              rows={2}
              value={notes}
              onChange={(formEvent) => setNotes(formEvent.target.value)}
              placeholder="Opcional"
              className={`${inputClassName} min-h-11 py-3`}
            />
          </div>
          {members.length > 0 ? (
            <div>
              <span id="task-assignees-label" className={labelClassName}>
                Responsables
              </span>
              <div role="group" aria-labelledby="task-assignees-label" className="flex flex-col gap-2">
                {members.map((member) => (
                  <div key={member.uid} className="flex items-center gap-3">
                    <Checkbox
                      checked={assignees.includes(member.uid)}
                      onCheckedChange={() =>
                        setAssignees((current) =>
                          current.includes(member.uid)
                            ? current.filter((id) => id !== member.uid)
                            : [...current, member.uid],
                        )
                      }
                      label={member.displayName}
                    />
                    <span className="text-body-sm text-foreground">{member.displayName}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {task !== null ? (
            <div>
              <span id="task-subtasks-label" className={labelClassName}>
                Subtareas ({subtasks.filter((item) => item.status === "done").length}/{subtasks.length})
              </span>
              <div role="group" aria-labelledby="task-subtasks-label" className="flex flex-col gap-2">
                {subtasks.map((subtask) => (
                  <div key={subtask.id} className="flex items-center gap-3">
                    <Checkbox
                      checked={subtask.status === "done"}
                      onCheckedChange={() => void toggleSubtask(subtask)}
                      label={subtask.title}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-body-sm",
                        subtask.status === "done"
                          ? "text-muted-foreground line-through"
                          : "text-foreground",
                      )}
                    >
                      {subtask.title}
                    </span>
                    <button
                      type="button"
                      aria-label={`Eliminar subtarea ${subtask.title}`}
                      onClick={() => {
                        setError(null);
                        deleteTask.mutate(subtask.id, {
                          onError: (err) => setError(err.message),
                        });
                      }}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
                    >
                      <Icon icon={Trash2} size={20} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={subtaskTitle}
                    onChange={(formEvent) => setSubtaskTitle(formEvent.target.value)}
                    onKeyDown={(formEvent) => {
                      if (formEvent.key === "Enter") {
                        formEvent.preventDefault();
                        void handleAddSubtask();
                      }
                    }}
                    placeholder="Nueva subtarea"
                    aria-label="Nueva subtarea"
                    className={inputClassName}
                  />
                  <button
                    type="button"
                    aria-label="Añadir subtarea"
                    onClick={() => void handleAddSubtask()}
                    disabled={createTask.isPending}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground outline-none interactive disabled:opacity-60"
                  >
                    <Icon icon={Plus} size={20} />
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? "Guardando…" : task === null ? "Crear tarea" : "Guardar cambios"}
          </Button>
          {task !== null ? (
            <Button
              type="button"
              variant="secondary"
              disabled={deleteTask.isPending}
              onClick={() => void handleDelete()}
              className="w-full"
            >
              {confirmDelete ? "Toca de nuevo para eliminar" : "Eliminar tarea"}
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
