"use client";

/**
 * Proyectos, tareas e ideas sobre Supabase.
 *
 * El progreso (hechas/total de tareas raíz) sale de la vista
 * `project_progress`. `position` ordena dentro de cada columna del kanban
 * (mayor = más abajo): al crear va al final, al mover se interpola.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type {
  IdeaItem,
  ProjectItem,
  TaskItem,
  TaskPriority,
  TaskStatus,
} from "@/types/organizer";

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];
type IdeaRow = Database["public"]["Tables"]["ideas"]["Row"];

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function mutationError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42501"
  ) {
    return "No tienes permiso para eso en este espacio.";
  }
  return fallback;
}

function toTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    title: row.title,
    notes: row.notes,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeIds: [...row.assignee_ids],
    dueAt: toTimestampOrNull(row.due_at),
    reminderAt: toTimestampOrNull(row.reminder_at),
    position: Number(row.position),
    parentTaskId: row.parent_task_id,
    completedAt: toTimestampOrNull(row.completed_at),
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function toIdea(row: IdeaRow): IdeaItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    detail: row.detail,
    tag: row.tag,
    createdBy: row.created_by ?? "",
    convertedTaskId: row.converted_task_id,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

// --- Proyectos -----------------------------------------------------------------

const PROJECT_COLUMNS =
  "id, workspace_id, name, description, emoji, color, status, due_date, created_by, is_system, created_at, updated_at";

function toProject(
  row: ProjectRow,
  progress: Map<string, { done: number; total: number }>,
): ProjectItem {
  const entry = progress.get(row.id);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    color: row.color,
    status: row.status as ProjectItem["status"],
    dueDate: row.due_date,
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    isSystem: row.is_system ?? false,
    done: entry?.done ?? 0,
    total: entry?.total ?? 0,
  };
}

export async function listProjects(wsId: string): Promise<ProjectItem[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("workspace_id", wsId)
    // La Bandeja primero, luego por creación.
    .order("is_system", { ascending: false })
    .order("created_at", { ascending: true });
  if (error !== null) {
    throw new Error("No se pudieron cargar los proyectos.");
  }
  const rows = (data ?? []) as ProjectRow[];
  const progress = new Map<string, { done: number; total: number }>();
  if (rows.length > 0) {
    const { data: counts } = await supabase
      .from("project_progress")
      .select("project_id, total, done")
      .in(
        "project_id",
        rows.map((row) => row.id),
      );
    for (const row of (counts ?? []) as { project_id: string; total: number; done: number }[]) {
      progress.set(row.project_id, { done: row.done, total: row.total });
    }
  }
  return rows.map((row) => toProject(row, progress));
}

export async function createProject(
  wsId: string,
  uid: string,
  input: { name: string; description?: string; emoji?: string; color?: string },
): Promise<string> {
  const name = input.name.trim();
  if (name === "") throw new Error("Ponle un nombre al proyecto.");
  const { data, error } = await getSupabaseClient()
    .from("projects")
    .insert({
      workspace_id: wsId,
      name,
      description: input.description ?? "",
      emoji: input.emoji ?? "📁",
      color: input.color ?? "#1d9bf0",
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo crear el proyecto."));
  }
  return (data as { id: string }).id;
}

export async function updateProject(
  id: string,
  patch: { name?: string; description?: string; emoji?: string; color?: string; status?: ProjectItem["status"]; dueDate?: string | null },
): Promise<void> {
  const data: Database["public"]["Tables"]["projects"]["Update"] = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === "") throw new Error("El proyecto no puede quedar sin nombre.");
    data["name"] = name;
  }
  if (patch.description !== undefined) data["description"] = patch.description;
  if (patch.emoji !== undefined) data["emoji"] = patch.emoji;
  if (patch.color !== undefined) data["color"] = patch.color;
  if (patch.status !== undefined) data["status"] = patch.status;
  if (patch.dueDate !== undefined) data["due_date"] = patch.dueDate;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("projects").update(data).eq("id", id);
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo guardar el proyecto."));
  }
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("projects").delete().eq("id", id);
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo eliminar el proyecto."));
  }
}

// --- Tareas --------------------------------------------------------------------

const TASK_COLUMNS =
  "id, project_id, workspace_id, title, notes, status, priority, assignee_ids, due_at, reminder_at, position, parent_task_id, completed_at, created_by, created_at, updated_at";

export async function listTasks(projectId: string): Promise<TaskItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(500);
  if (error !== null) {
    throw new Error("No se pudieron cargar las tareas.");
  }
  return ((data ?? []) as TaskRow[]).map(toTask);
}

/** Tareas del espacio (para Inicio): ordenadas por vencimiento. */
export async function listWorkspaceTasks(wsId: string): Promise<TaskItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("workspace_id", wsId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error !== null) {
    throw new Error("No se pudieron cargar las tareas.");
  }
  return ((data ?? []) as TaskRow[]).map(toTask);
}

export type CreateTaskInput = {
  title: string;
  notes?: string;
  priority?: TaskPriority;
  assigneeIds?: string[];
  dueAt?: Date | null;
  reminderAt?: Date | null;
  parentTaskId?: string | null;
};

export async function createTask(
  projectId: string,
  wsId: string,
  uid: string,
  input: CreateTaskInput,
): Promise<string> {
  const title = input.title.trim();
  if (title === "") throw new Error("Ponle un título a la tarea.");
  const supabase = getSupabaseClient();
  const { data: last } = await supabase
    .from("tasks")
    .select("position")
    .eq("project_id", projectId)
    .eq("status", "todo")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position =
    last !== null && typeof (last as { position: unknown }).position !== "undefined"
      ? Number((last as { position: number }).position) + 1024
      : 1024;
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      project_id: projectId,
      workspace_id: wsId,
      title,
      notes: input.notes ?? "",
      priority: input.priority ?? "normal",
      assignee_ids: input.assigneeIds ?? [],
      due_at: input.dueAt?.toISOString() ?? null,
      reminder_at: input.reminderAt?.toISOString() ?? null,
      parent_task_id: input.parentTaskId ?? null,
      position,
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo crear la tarea."));
  }
  return (data as { id: string }).id;
}

export async function updateTask(
  id: string,
  patch: {
    title?: string;
    notes?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeIds?: string[];
    dueAt?: Date | null;
    reminderAt?: Date | null;
    position?: number;
  },
): Promise<void> {
  const data: Database["public"]["Tables"]["tasks"]["Update"] = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title === "") throw new Error("La tarea no puede quedar sin título.");
    data["title"] = title;
  }
  if (patch.notes !== undefined) data["notes"] = patch.notes;
  if (patch.status !== undefined) {
    data["status"] = patch.status;
    data["completed_at"] =
      patch.status === "done" ? new Date().toISOString() : null;
  }
  if (patch.priority !== undefined) data["priority"] = patch.priority;
  if (patch.assigneeIds !== undefined) data["assignee_ids"] = patch.assigneeIds;
  if (patch.dueAt !== undefined) data["due_at"] = patch.dueAt?.toISOString() ?? null;
  if (patch.reminderAt !== undefined) {
    data["reminder_at"] = patch.reminderAt?.toISOString() ?? null;
  }
  if (patch.position !== undefined) data["position"] = patch.position;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("tasks").update(data).eq("id", id);
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo guardar la tarea."));
  }
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("tasks").delete().eq("id", id);
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo eliminar la tarea."));
  }
}

/** Posición intermedia para soltar entre dos tareas (o en un extremo). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return (after as number) - 1024;
  if (after === null) return before + 1024;
  if (after - before < 0.001) return before + 0.5;
  return (before + after) / 2;
}

// --- Ideas ---------------------------------------------------------------------

export async function listIdeas(wsId: string): Promise<IdeaItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("ideas")
    .select("id, workspace_id, title, detail, tag, created_by, converted_task_id, created_at, updated_at")
    .eq("workspace_id", wsId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error !== null) {
    throw new Error("No se pudieron cargar las ideas.");
  }
  return ((data ?? []) as IdeaRow[]).map(toIdea);
}

export async function createIdea(
  wsId: string,
  uid: string,
  input: { title: string; detail?: string; tag?: string },
): Promise<string> {
  const title = input.title.trim();
  if (title === "") throw new Error("Ponle un título a la idea.");
  const { data, error } = await getSupabaseClient()
    .from("ideas")
    .insert({
      workspace_id: wsId,
      title,
      detail: input.detail ?? "",
      tag: input.tag ?? "",
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo crear la idea."));
  }
  return (data as { id: string }).id;
}

export async function deleteIdea(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("ideas").delete().eq("id", id);
  if (error !== null) {
    throw new Error(mutationError(error, "No se pudo eliminar la idea."));
  }
}

/** Convierte una idea en tarea del proyecto y la marca como convertida. */
export async function convertIdeaToTask(
  idea: IdeaItem,
  projectId: string,
  uid: string,
): Promise<string> {
  const taskId = await createTask(projectId, idea.workspaceId, uid, {
    title: idea.title,
    notes: idea.detail,
  });
  const { error } = await getSupabaseClient()
    .from("ideas")
    .update({ converted_task_id: taskId })
    .eq("id", idea.id);
  if (error !== null) {
    throw new Error(mutationError(error, "La tarea se creó pero no se pudo marcar la idea."));
  }
  return taskId;
}
