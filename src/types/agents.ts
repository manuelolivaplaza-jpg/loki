import type { Timestamp } from "@/lib/timestamp";

/**
 * Agentes personales (etapa 2, prompt 12): tipos camelCase de la UI.
 * El adaptador `src/lib/data/agents.ts` traduce el snake_case de Postgres.
 * Contrato completo en `docs/AGENTES.md`.
 */

export type AgentProvider =
  | "generic_webhook"
  | "grokbot"
  | "hermes"
  | "a2a";

export const AGENT_PROVIDERS: readonly {
  value: AgentProvider;
  label: string;
  detail: string;
  ready: boolean;
}[] = [
  {
    value: "generic_webhook",
    label: "Webhook genérico",
    detail: "Cualquier agente con una URL https que reciba el pedido y responda al callback.",
    ready: true,
  },
  {
    value: "grokbot",
    label: "Grok Bot",
    detail: "Tu bot de Grok Bot (rutina con trigger webhook). Se conecta en el prompt 13.",
    ready: false,
  },
  {
    value: "hermes",
    label: "Hermes Agent",
    detail: "Se conecta en el prompt 13.",
    ready: false,
  },
  {
    value: "a2a",
    label: "A2A (Agent2Agent)",
    detail: "Agente compatible con el protocolo abierto A2A. Se conecta en el prompt 13.",
    ready: false,
  },
];

export type AgentStatus = "active" | "paused" | "error";

export interface AgentConnection {
  id: string;
  provider: AgentProvider;
  name: string;
  /** Sin @ y en minúsculas (para mencionar: `@handle`). */
  handle: string;
  description: string;
  avatarEmoji: string;
  /** URL de disparo (vive en config.dispatch_url, editable por el dueño). */
  dispatchUrl: string;
  /** ¿Tiene secreto saliente guardado? (nunca se muestra). */
  hasOutbound: boolean;
  /** ¿Tiene token entrante vigente? (nunca se muestra). */
  hasInbound: boolean;
  status: AgentStatus;
  lastError: string | null;
  lastUsedAt: Timestamp | null;
}

export type AgentAllowedCallers = "owner_only" | "space_members" | "listed";

export interface AgentSpaceGrant {
  id: string;
  connectionId: string;
  workspaceId: string;
  enabled: boolean;
  adminDisabled: boolean;
  allowedCallers: AgentAllowedCallers;
  allowedUserIds: string[];
  allowContext: boolean;
  contextMessages: number;
  allowDmContext: boolean;
  allowPublish: boolean;
  allowProposeActions: boolean;
  dailyLimit: number;
}

export type AgentRunStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "needs_input"
  | "done"
  | "error"
  | "cancelled"
  | "expired";

export type AgentRunKind = "task" | "ping";

export interface AgentRun {
  id: string;
  connectionId: string;
  workspaceId: string;
  chatId: string;
  requestedBy: string | null;
  kind: AgentRunKind;
  instruction: string;
  status: AgentRunStatus;
  tokenExpiresAt: Timestamp | null;
  deadlineAt: Timestamp | null;
  result: AgentRunResult | null;
  error: string | null;
  cancelRequestedAt: Timestamp | null;
  createdAt: Timestamp;
  finishedAt: Timestamp | null;
}

export interface AgentRunLink {
  title: string;
  url: string;
}

export interface AgentProposedAction {
  type: "create_task" | "create_event" | "create_reminder" | "add_list_items";
  title: string;
  due_at?: string;
  notes?: string;
  items?: string[];
}

export interface AgentRunResult {
  text: string;
  links: AgentRunLink[];
  proposedActions: AgentProposedAction[];
}

export type AgentEventType =
  | "ack"
  | "progress"
  | "needs_input"
  | "result"
  | "error"
  | "cancelled"
  | "expired"
  | "dispatch_failed";

export interface AgentRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: AgentEventType;
  text: string;
  percent: number | null;
  createdAt: Timestamp;
}

/** Texto humano por estado, para la tarjeta de ejecución. */
export const AGENT_RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  queued: "Enviando…",
  dispatched: "Recibió el pedido",
  running: "Está trabajando…",
  needs_input: "Necesita tu respuesta",
  done: "Terminó",
  error: "Falló",
  cancelled: "Cancelada",
  expired: "Sin respuesta a tiempo",
};
