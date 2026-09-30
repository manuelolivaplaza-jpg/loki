"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { positionBetween } from "@/lib/data/projects";
import { useUpdateTask } from "@/hooks/use-organizer";
import type { TaskItem, TaskStatus } from "@/types/organizer";
import { cn } from "@/lib/utils";

const COLUMNS: readonly { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "Por hacer" },
  { key: "doing", label: "En curso" },
  { key: "done", label: "Hechas" },
];

function priorityDot(priority: TaskItem["priority"]): string {
  if (priority === "high") return "bg-danger";
  if (priority === "low") return "bg-muted-foreground";
  return "bg-accent";
}

export function KanbanBoard({
  tasks,
  onOpen,
}: {
  tasks: TaskItem[];
  onOpen: (task: TaskItem) => void;
}): React.JSX.Element {
  const updateTask = useUpdateTask();
  const [error, setError] = React.useState<string | null>(null);
  const roots = React.useMemo(
    () => tasks.filter((task) => task.parentTaskId === null),
    [tasks],
  );

  function dropOnColumn(status: TaskStatus, taskId: string): void {
    const task = roots.find((item) => item.id === taskId);
    if (task === undefined) return;
    const column = roots
      .filter((item) => item.status === status && item.id !== taskId)
      .sort((a, b) => a.position - b.position);
    const last = column[column.length - 1];
    setError(null);
    updateTask.mutate(
      { id: taskId, patch: { status, position: positionBetween(last?.position ?? null, null) } },
      { onError: (err) => setError(err.message) },
    );
  }

  function dropBefore(before: TaskItem, taskId: string): void {
    const task = roots.find((item) => item.id === taskId);
    if (task === undefined || before.id === taskId) return;
    const column = roots
      .filter((item) => item.status === before.status && item.id !== taskId)
      .sort((a, b) => a.position - b.position);
    const index = column.findIndex((item) => item.id === before.id);
    const prev = index > 0 ? column[index - 1] : undefined;
    setError(null);
    updateTask.mutate(
      {
        id: taskId,
        patch: {
          status: before.status,
          position: positionBetween(prev?.position ?? null, before.position),
        },
      },
      { onError: (err) => setError(err.message) },
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const cards = roots
            .filter((task) => task.status === column.key)
            .sort((a, b) => a.position - b.position);
          return (
            <section
              key={column.key}
              aria-label={column.label}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const taskId = event.dataTransfer.getData("text/loki-task");
                if (taskId !== "") dropOnColumn(column.key, taskId);
              }}
              className="flex min-h-32 flex-col gap-2 rounded-lg bg-surface-soft/60 p-2"
            >
              <p className="px-1 text-meta font-semibold text-muted-foreground">
                {column.label} · {cards.length}
              </p>
              {cards.map((task) => (
                <div
                  key={task.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const taskId = event.dataTransfer.getData("text/loki-task");
                    if (taskId !== "") dropBefore(task, taskId);
                  }}
                >
                  <Card
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir tarea ${task.title}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/loki-task", task.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onOpen(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen(task);
                      }
                    }}
                    className="cursor-grab bg-background p-3 outline-none interactive"
                  >
                    <span className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", priorityDot(task.priority))}
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 text-body-sm font-medium leading-5 text-foreground",
                          task.status === "done" && "line-through text-muted-foreground",
                        )}
                      >
                        {task.title}
                      </span>
                      <span onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={task.status === "done"}
                          onCheckedChange={() => {
                            setError(null);
                            updateTask.mutate(
                              {
                                id: task.id,
                                patch: { status: task.status === "done" ? "todo" : "done" },
                              },
                              { onError: (err) => setError(err.message) },
                            );
                          }}
                          label={task.title}
                        />
                      </span>
                    </span>
                  </Card>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
