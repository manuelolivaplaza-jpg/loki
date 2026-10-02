"use client";

import * as React from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ListPlus,
  Loader2,
  Lock,
  RotateCcw,
  X,
} from "lucide-react";
import { SafeText } from "@/components/chat/safe-text";
import { Icon } from "@/components/ui/icon";
import { useAgentRun } from "@/hooks/use-agents";
import { cancelAgentRun, startAgentTask } from "@/lib/data/agents";
import { createEvent } from "@/lib/data/events";
import { addListItem, createShoppingList } from "@/lib/data/lists";
import { createTask } from "@/lib/data/projects";
import { getSupabaseClient } from "@/lib/supabase/client";
import { AGENT_RUN_STATUS_LABEL, type AgentProposedAction } from "@/types/agents";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<AgentProposedAction["type"], string> = {
  create_task: "Crear tarea",
  create_event: "Crear evento",
  create_reminder: "Crear recordatorio",
  add_list_items: "Agregar a lista",
};

function parseDue(raw: string | undefined): Date | null {
  if (raw === undefined || raw === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Tarjeta de ejecución de un agente bajo el mensaje que lo invocó.
 *
 * - "mi-bot está trabajando…" con los eventos de progreso en vivo (Realtime
 *   sobre agent_run_events, más reintento cada 3 s mientras viva).
 * - Botón Cancelar mientras viva (quien invocó o el dueño; la RPC lo valida).
 * - Al terminar: resultado con safe-text (enlaces solo http/https), enlaces y
 *   acciones propuestas como tarjeta de confirmación (el agente nunca escribe
 *   directo: cada acción la crea el usuario con su JWT al confirmar).
 * - needs_input: pregunta + "Responde en el hilo" (la respuesta viaja como
 *   continuación con agent_continue_run).
 * - Compacta en móvil (una línea + "ver más" en hoja inferior) y extendida en
 *   escritorio (línea de tiempo). El contenido del tercero se muestra como
 *   texto, jamás se ejecuta (SafeText, sin HTML).
 */
export function AgentRunCard({
  runId,
  wsId,
  uid,
  botName,
  botEmoji,
  isPrivate = false,
  onOpenThread,
}: {
  runId: string;
  wsId: string;
  uid: string | null;
  botName: string;
  botEmoji?: string;
  /** allow_publish = false: el resultado es privado para quien invocó. */
  isPrivate?: boolean;
  onOpenThread?: () => void;
}): React.JSX.Element | null {
  const { run, events, isPending, error, retry } = useAgentRun(runId);
  const [expanded, setExpanded] = React.useState(false);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [doneActions, setDoneActions] = React.useState<Set<string>>(new Set());
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 px-1 py-1 text-body-sm text-muted-foreground">
        <Icon icon={Loader2} size={16} className="animate-spin" />
        Enviando al bot…
      </p>
    );
  }
  if (error !== null || run === null) {
    return (
      <div className="flex flex-col gap-1 rounded-2xl border border-divider bg-card px-3 py-2">
        <p role="alert" className="text-body-sm text-danger">{error ?? "No se pudo cargar."}</p>
        <button
          type="button"
          onClick={retry}
          className="flex min-h-11 items-center gap-1 self-start text-body-sm font-semibold text-accent outline-none"
        >
          <Icon icon={RotateCcw} size={16} />
          Reintentar
        </button>
      </div>
    );
  }

  const status = run.status;
  const live = status === "queued" || status === "dispatched" ||
    status === "running" || status === "needs_input";
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const needsInput = status === "needs_input"
    ? events.filter((event) => event.type === "needs_input").slice(-1)[0] ?? null
    : null;
  const actions = run.result?.proposedActions ?? [];
  const links = run.result?.links ?? [];
  const canCancel = live && uid !== null &&
    (run.requestedBy === uid || run.requestedBy === null);

  async function handleCancel(): Promise<void> {
    try {
      await cancelAgentRun(run.id);
    } catch {
      // El error ya quedó visible vía mutations o el próximo evento.
    }
  }

  async function handleRetry(): Promise<void> {
    if (uid === null || retrying) return;
    setRetrying(true);
    try {
      await startAgentTask({
        connectionId: run.connectionId,
        workspaceId: run.workspaceId,
        chatId: run.chatId,
        messageId: null,
        uid,
        instruction: run.instruction === "" ? "Reintenta lo pedido." : run.instruction,
      });
    } catch {
      // Se muestra reintentando en la tarjeta original.
    } finally {
      setRetrying(false);
    }
  }

  async function handleConfirmAction(action: AgentProposedAction, index: number): Promise<void> {
    if (uid === null || confirming !== null) return;
    const key = `${index}:${action.type}:${action.title}`;
    setConfirming(key);
    setActionError(null);
    try {
      if (action.type === "create_task" || action.type === "create_reminder") {
        const { data } = await getSupabaseClient()
          .rpc("ensure_inbox_project", { p_workspace_id: wsId });
        if (typeof data !== "string" || data === "") {
          throw new Error("No se pudo abrir la Bandeja del espacio.");
        }
        const due = parseDue(action.due_at);
        await createTask(data, wsId, uid, {
          title: action.title.slice(0, 200),
          notes: (action.notes ?? "").slice(0, 1000),
          ...(due !== null
            ? action.type === "create_reminder"
              ? { reminderAt: due }
              : { dueAt: due }
            : {}),
        });
      } else if (action.type === "create_event") {
        const start = parseDue(action.due_at) ?? new Date(Date.now() + 3_600_000);
        await createEvent(wsId, uid, {
          title: action.title.slice(0, 200),
          description: (action.notes ?? "").slice(0, 1000),
          startsAt: start,
          endsAt: new Date(start.getTime() + 3_600_000),
        });
      } else {
        const listId = await createShoppingList(wsId, uid, {
          title: action.title.slice(0, 120),
          kind: "checklist",
        });
        const items = (action.items ?? []).slice(0, 20).filter((item) => item.trim() !== "");
        for (const item of items.length > 0 ? items : [action.title]) {
          await addListItem(listId, wsId, uid, { text: item.slice(0, 200) });
        }
      }
      setDoneActions((prev) => new Set([...prev, key]));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo crear. Inténtalo de nuevo.");
    } finally {
      setConfirming(null);
    }
  }

  return (
    <div
      aria-live="polite"
      aria-label={`Ejecución de ${botName}: ${AGENT_RUN_STATUS_LABEL[status]}`}
      className="flex w-full max-w-[420px] flex-col gap-2 rounded-2xl border border-divider bg-card px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-[16px] leading-none">
          {botEmoji ?? "🤖"}
        </span>
        <p className="min-w-0 flex-1 truncate text-body-sm">
          <span className="font-semibold text-foreground">@{botName}</span>{" "}
          <span className="text-muted-foreground">
            {live
              ? status === "needs_input"
                ? "necesita tu respuesta"
                : "está trabajando…"
              : AGENT_RUN_STATUS_LABEL[status]}
          </span>
        </p>
        {isPrivate ? (
          <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
            <Icon icon={Lock} size={14} />
            Solo tú
          </span>
        ) : null}
        {live ? (
          <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-divider border-t-accent" />
        ) : null}
      </div>

      {lastEvent !== null && lastEvent.text !== "" && live ? (
        <p className="truncate text-body-sm leading-5 text-muted-foreground">
          {lastEvent.text}
        </p>
      ) : null}

      {needsInput !== null ? (
        <div className="rounded-xl bg-surface-soft px-3 py-2">
          <p className="text-body-sm font-medium leading-5 text-foreground">
            <SafeText text={needsInput.text} />
          </p>
          <p className="mt-0.5 text-meta leading-4 text-muted-foreground">
            Responde en el hilo y eso viaja como continuación.
          </p>
          {onOpenThread !== undefined ? (
            <button
              type="button"
              onClick={onOpenThread}
              className="mt-1 flex min-h-11 items-center text-body-sm font-semibold text-accent outline-none"
            >
              Abrir hilo para responder
            </button>
          ) : null}
        </div>
      ) : null}

      {status === "done" && run.result !== null ? (
        <div className="flex flex-col gap-2">
          <p className="whitespace-pre-wrap break-words text-body-sm leading-5 text-foreground">
            <SafeText text={run.result.text} />
          </p>
          {links.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {links.map((link, index) => (
                <li key={`${link.url}-${index}`} className="truncate text-body-sm">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-mention underline underline-offset-2 outline-none"
                  >
                    {link.title === "" ? link.url : link.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {actions.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-xl border border-divider p-2">
              <p className="flex items-center gap-1 text-meta font-semibold leading-4 text-muted-foreground">
                <Icon icon={ListPlus} size={14} />
                Propone {actions.length === 1 ? "una acción" : `${actions.length} acciones`} · tú confirmas
              </p>
              <ul className="flex flex-col gap-1.5">
                {actions.map((action, index) => {
                  const key = `${index}:${action.type}:${action.title}`;
                  const done = doneActions.has(key);
                  return (
                    <li key={key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm text-foreground">
                          {done ? "✓ " : ""}{action.title}
                        </span>
                        <span className="block text-meta leading-4 text-muted-foreground">
                          {ACTION_LABEL[action.type]}
                          {action.due_at !== undefined && action.due_at !== "" ? ` · ${action.due_at}` : ""}
                        </span>
                      </span>
                      {!done ? (
                        <button
                          type="button"
                          disabled={confirming !== null || uid === null}
                          onClick={() => void handleConfirmAction(action, index)}
                          className="flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-surface-soft px-3 text-body-sm font-semibold text-foreground outline-none interactive disabled:opacity-60"
                        >
                          {confirming === key ? (
                            <Icon icon={Loader2} size={16} className="animate-spin" />
                          ) : (
                            <Icon icon={Check} size={16} />
                          )}
                          Crear
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {actionError !== null ? (
                <p role="alert" className="text-body-sm text-danger">{actionError}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {(status === "error" || status === "expired") && run.error !== null && run.error !== "" ? (
        <p role="alert" className="text-body-sm leading-5 text-danger">{run.error}</p>
      ) : null}
      {status === "cancelled" ? (
        <p className="text-body-sm leading-5 text-muted-foreground">Cancelada.</p>
      ) : null}

      {/* Línea de tiempo: compacta en móvil (una línea + ver más), extendida en escritorio. */}
      {events.length > 0 ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className="flex min-h-11 items-center gap-1 self-start text-body-sm font-medium text-muted-foreground outline-none"
          >
            <Icon
              icon={ChevronDown}
              size={16}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
            {expanded ? "Ocultar progreso" : `Ver progreso (${events.length})`}
            <span className="hidden md:inline"> · línea de tiempo</span>
          </button>
          {expanded ? (
            <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto border-l-2 border-divider pl-3 md:max-h-64">
              {events.map((event) => (
                <li key={event.id} className="text-body-sm leading-5">
                  <span className="text-meta text-muted-foreground">
                    {event.type === "needs_input"
                      ? "Pregunta"
                      : event.type === "result"
                        ? "Resultado"
                        : event.type === "error"
                          ? "Error"
                          : event.type === "expired"
                            ? "Expiró"
                            : event.type === "cancelled"
                              ? "Cancelada"
                              : event.type === "dispatch_failed"
                                ? "No se pudo enviar"
                                : "Progreso"}
                    {" · "}
                  </span>
                  <span className="text-foreground">
                    <SafeText text={event.text === "" ? "…" : event.text} />
                  </span>
                  {event.percent !== null ? (
                    <span className="text-muted-foreground"> · {event.percent}%</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {live && canCancel ? (
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="flex min-h-11 items-center gap-1 rounded-full px-2 text-body-sm font-medium text-muted-foreground outline-none interactive"
          >
            <Icon icon={X} size={16} />
            Cancelar
          </button>
        ) : null}
        {!live && (status === "error" || status === "expired") && uid !== null ? (
          <button
            type="button"
            disabled={retrying}
            onClick={() => void handleRetry()}
            className="flex min-h-11 items-center gap-1 rounded-full px-2 text-body-sm font-semibold text-accent outline-none interactive disabled:opacity-60"
          >
            <Icon icon={RotateCcw} size={16} />
            {retrying ? "Reintentando…" : "Reintentar"}
          </button>
        ) : null}
        {!live ? (
          <span className="flex items-center gap-1 text-meta text-muted-foreground">
            <Icon icon={Bot} size={14} />
            {AGENT_RUN_STATUS_LABEL[status]}
          </span>
        ) : null}
      </div>
    </div>
  );
}
