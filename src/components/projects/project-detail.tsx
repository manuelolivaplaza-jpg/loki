"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ArrowLeft, List, Columns3, Plus } from "lucide-react";
import { Card, CardDivider } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { KanbanBoard } from "@/components/projects/kanban-board";
/** Hoja de tarea por code splitting: solo se descarga al crear/editar. */
const TaskSheet = dynamic(
  () => import("@/components/projects/task-sheet").then((mod) => mod.TaskSheet),
  { ssr: false },
);
import { useTasks, useUpdateTask } from "@/hooks/use-organizer";
import type { ProjectItem, TaskItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

type DetailView = "list" | "board";

function dueLabel(task: TaskItem): string | null {
  if (task.dueAt === null) return null;
  const date = task.dueAt.toDate();
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  if (sameDay) return `Hoy · ${time}`;
  const day = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric" })
    .format(date)
    .replace(".", "");
  return `${day} · ${time}`;
}

export function ProjectDetail({
  project,
  deepTaskId,
  onBack,
}: {
  project: ProjectItem;
  /** ?task=: abre la hoja al cargar. */
  deepTaskId: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const [view, setView] = React.useState<DetailView>("list");
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TaskItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const tasksQuery = useTasks(project.id);
  const updateTask = useUpdateTask();

  const tasks = React.useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.parentTaskId === null),
    [tasksQuery.data],
  );

  // Enlace profundo a una tarea (desde notificaciones): abre su hoja.
  const deepOpenedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (deepTaskId === null || deepOpenedRef.current === deepTaskId) return;
    const found = (tasksQuery.data ?? []).find((task) => task.id === deepTaskId);
    if (found !== undefined) {
      deepOpenedRef.current = deepTaskId;
      setEditing(found);
      setSheetOpen(true);
    }
  }, [deepTaskId, tasksQuery.data]);

  function openNew(): void {
    setEditing(null);
    setSheetOpen(true);
  }

  function openTask(task: TaskItem): void {
    setEditing(task);
    setSheetOpen(true);
  }

  async function toggle(task: TaskItem): Promise<void> {
    setError(null);
    try {
      await updateTask.mutateAsync({
        id: task.id,
        patch: { status: task.status === "done" ? "todo" : "done" },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la tarea.");
    }
  }

  const percent =
    project.total === 0 ? 0 : Math.round((project.done / project.total) * 100);

  return (
    <div>
      <div className="flex items-center gap-2">
        <IconButton variant="ghost" aria-label="Volver a proyectos" onClick={onBack}>
          <Icon icon={ArrowLeft} size={20} />
        </IconButton>
        <span aria-hidden="true" className="text-title">
          {project.emoji}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">
          {project.name}
        </h2>
        <IconButton variant="solid" aria-label="Nueva tarea" onClick={openNew}>
          <Icon icon={Plus} size={20} />
        </IconButton>
      </div>
      {project.description !== "" ? (
        <p className="mt-1 px-12 text-body-sm text-muted-foreground">{project.description}</p>
      ) : null}
      <p className="mt-1 px-12 text-meta text-muted-foreground" aria-label={`Progreso ${percent} por ciento`}>
        {project.done} de {project.total} · {percent}%
      </p>

      <div
        role="tablist"
        aria-label="Vista del proyecto"
        className="mt-3 flex rounded-full bg-surface-soft p-1"
      >
        {(
          [
            { key: "list", label: "Lista", icon: List },
            { key: "board", label: "Tablero", icon: Columns3 },
          ] as const
        ).map((item) => {
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
                "flex h-9 flex-1 items-center justify-center gap-2 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                selected
                  ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                  : "text-muted-foreground",
              )}
            >
              <Icon icon={item.icon} size={20} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {tasksQuery.isPending && tasks.length === 0 ? (
          <div aria-label="Cargando tareas" className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className="block h-14 animate-pulse rounded-lg bg-surface-soft"
              />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <Card>
            <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
              Sin tareas. Crea la primera con +.
            </p>
          </Card>
        ) : view === "board" ? (
          <KanbanBoard tasks={tasksQuery.data ?? []} onOpen={openTask} />
        ) : (
          <Card>
            {tasks.map((task, index) => {
              const meta = dueLabel(task);
              return (
                <React.Fragment key={task.id}>
                  {index > 0 ? <CardDivider /> : null}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Checkbox
                      checked={task.status === "done"}
                      onCheckedChange={() => void toggle(task)}
                      label={task.title}
                    />
                    <button
                      type="button"
                      onClick={() => openTask(task)}
                      aria-label={`Abrir tarea ${task.title}`}
                      className="min-w-0 flex-1 text-left outline-none"
                    >
                      <span
                        className={cn(
                          "block truncate text-body-sm font-medium leading-5",
                          task.status === "done"
                            ? "text-muted-foreground line-through"
                            : "text-foreground",
                        )}
                      >
                        {task.title}
                      </span>
                      {meta !== null ? (
                        <span className="block truncate text-meta leading-4 text-muted-foreground">
                          {meta}
                        </span>
                      ) : null}
                    </button>
                  </div>
                </React.Fragment>
              );
            })}
          </Card>
        )}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      ) : null}

      {sheetOpen ? (
        <TaskSheet
          open={sheetOpen}
          projectId={project.id}
          task={editing}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function ProjectDetailEmpty(): React.JSX.Element {
  return (
    <EmptyState
      icon={List}
      title="Elige un proyecto"
      description="Selecciona uno de la lista para ver sus tareas."
    />
  );
}
