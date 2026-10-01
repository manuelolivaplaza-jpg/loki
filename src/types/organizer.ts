import type { Timestamp } from "@/lib/timestamp";

/** Recurrencia de evento (se expande en el cliente sobre la ventana visible). */
export type EventRecurrence = "daily" | "weekly" | "monthly";

export interface EventItem {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  description: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  allDay: boolean;
  location: string;
  color: string;
  createdBy: string;
  attendees: string[];
  reminderMinutes: number[];
  recurrence: EventRecurrence | null;
  /** Id en Google Calendar (null = solo Loki). */
  externalId: string | null;
  /** Origen: "loki" o "google". */
  externalSource: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Ocurrencia expandida (misma forma, con el id base + fecha). */
export interface EventOccurrence extends EventItem {
  /** Id estable de la ocurrencia: `${id}@${ISO}`. */
  occurrenceId: string;
}

export type ProjectStatus = "active" | "archived";

export interface ProjectItem {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  status: ProjectStatus;
  dueDate: string | null;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** True en la Bandeja del espacio (no se borra ni se archiva). */
  isSystem: boolean;
  /** Hechas/total de tareas raíz (viene de `project_progress`). */
  done: number;
  total: number;
}

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "low" | "normal" | "high";

export interface TaskItem {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeIds: string[];
  dueAt: Timestamp | null;
  reminderAt: Timestamp | null;
  position: number;
  parentTaskId: string | null;
  completedAt: Timestamp | null;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IdeaItem {
  id: string;
  workspaceId: string;
  title: string;
  detail: string;
  tag: string;
  createdBy: string;
  convertedTaskId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type NotificationType =
  | "mention"
  | "reply"
  | "reaction"
  | "task_assigned"
  | "task_due"
  | "event_reminder"
  | "invite"
  | "ai_alert";

export interface NotificationItem {
  id: string;
  userId: string;
  workspaceId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  readAt: Timestamp | null;
  createdAt: Timestamp;
}

export type NotificationTypeKey =
  | "mention"
  | "reply"
  | "reaction"
  | "task_assigned"
  | "task_due"
  | "event_reminder"
  | "invite"
  | "ai_alert";

export interface NotificationPrefs {
  mention: boolean;
  reply: boolean;
  reaction: boolean;
  task_assigned: boolean;
  task_due: boolean;
  event_reminder: boolean;
  invite: boolean;
  ai_alert: boolean;
  quietStart: string | null;
  quietEnd: string | null;
}

export interface InviteItem {
  id: string;
  code: string;
  workspaceId: string;
  createdBy: string | null;
  role: "member" | "admin";
  expiresAt: Timestamp | null;
  maxUses: number | null;
  uses: number;
  revokedAt: Timestamp | null;
  createdAt: Timestamp;
}
