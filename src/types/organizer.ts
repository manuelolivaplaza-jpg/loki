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
  | "ai_alert"
  | "list"
  | "poll";

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
  | "ai_alert"
  | "list"
  | "poll";

export interface NotificationPrefs {
  mention: boolean;
  reply: boolean;
  reaction: boolean;
  task_assigned: boolean;
  task_due: boolean;
  event_reminder: boolean;
  invite: boolean;
  ai_alert: boolean;
  list: boolean;
  poll: boolean;
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

export type ListKind = "groceries" | "chores" | "checklist";

export interface ShoppingList {
  id: string;
  workspaceId: string;
  title: string;
  emoji: string;
  color: string;
  kind: ListKind;
  pinned: boolean;
  archived: boolean;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Ítems sin marcar / total (para el widget de Inicio). */
  open: number;
  total: number;
}

export interface ListItem {
  id: string;
  listId: string;
  workspaceId: string;
  text: string;
  quantity: string;
  unit: string;
  category: string;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: Timestamp | null;
  assigneeId: string | null;
  dueAt: Timestamp | null;
  position: number;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ListWatcher {
  userId: string;
  listId: string;
  onAdd: boolean;
  onComplete: boolean;
}

// --- Encuestas (polls) ------------------------------------------------------------

/** Opción única, múltiple, sí/no rápido o elegir fecha. */
export type PollKind = "single" | "multiple" | "yesno" | "date";

/** Quién puede cerrar la encuesta además del creador y los admins. */
export type PollCloseBy = "creator" | "anyone";

export interface PollSettings {
  /** Las barras se ven igual, pero nunca quién votó. */
  anonymous: boolean;
  /** Que el resto pueda agregar opciones mientras esté abierta. */
  allowSuggestions: boolean;
  /** Aviso único a quien no vote antes del cierre. */
  remindMissing: boolean;
  closeBy: PollCloseBy;
}

export interface PollOptionView {
  id: string;
  text: string;
  /** Rango propuesto (solo kind 'date'). */
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  position: number;
  addedBy: string | null;
  votes: number;
  /** True si esta opción es la que elegí (siempre, también en las anónimas). */
  mine: boolean;
  /** Uids que voting: vacío en las anónimas (ni la RLS ni la RPC lo dan). */
  voters: string[];
  /** Miembros con algo agendado a esa hora (kind 'date'); null si no aplica. */
  busy: number | null;
}

/**
 * Estado completo de la encuesta que devuelve `poll_results`: lo que la tarjeta
 * pinta. El resultado sale de los votos al leer; como al cerrar ya no se puede
 * votar, queda fijado sin desnormalizar nada.
 */
export interface PollView {
  id: string;
  messageId: string;
  workspaceId: string;
  chatId: string;
  question: string;
  kind: PollKind;
  settings: PollSettings;
  closesAt: Timestamp | null;
  closedAt: Timestamp | null;
  closedBy: string | null;
  createdBy: string | null;
  createdAt: Timestamp;
  anonymous: boolean;
  allowSuggestions: boolean;
  remindMissing: boolean;
  closeBy: PollCloseBy;
  isOpen: boolean;
  /** Puedo cerrar/editar (creador, admin o closeBy = anyone). */
  canManage: boolean;
  /** Puedo agregar opciones ahora mismo. */
  canSuggest: boolean;
  options: PollOptionView[];
  maxVotes: number;
  /** Ids ganadores (vacío si no hay votos o hay empate). */
  winners: string[];
  /** Empate con votos: lo muestra, decide quien creó la encuesta. */
  tied: boolean;
  totalVotes: number;
  membersCount: number;
  /** Cuántos del padrón todavía no han votado. */
  missingCount: number;
  /** Uids que faltan (vacío en las anónimas). */
  missing: string[];
}

/** Opción en construcción (crear encuesta o editar). */
export interface PollDraftOption {
  text: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface NewPollInput {
  question: string;
  kind: PollKind;
  settings: PollSettings;
  closesAt: Date | null;
  options: PollDraftOption[];
}
