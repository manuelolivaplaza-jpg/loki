"use client";

import * as React from "react";
import {
  BellRing,
  CalendarPlus,
  CheckCircle2,
  ListPlus,
  Megaphone,
  Pencil,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AiPendingAction,
  AiPendingItem,
  LokiConfirmItem,
  UndoItem,
} from "@/lib/ai/tools-client";
import { cn } from "@/lib/utils";

export type CardMember = { uid: string; name: string };
export type CardProject = { id: string; name: string; isSystem: boolean };
export type CardWorkspace = { id: string; name: string };

export type CardConfirmPayload = {
  actions?: LokiConfirmItem[];
  params: Record<string, unknown>;
  workspaceId?: string;
};

/** Icono por acción de escritura (solo decorativo). */
function ActionIcon({ action }: { action: string }): React.JSX.Element {
  const className = "h-5 w-5 shrink-0 text-primary";
  if (action === "create_event" || action === "update_event") {
    return <CalendarPlus className={className} aria-hidden="true" />;
  }
  if (action === "create_task" || action === "update_task") {
    return <ListPlus className={className} aria-hidden="true" />;
  }
  if (action === "complete_task") return <CheckCircle2 className={className} aria-hidden="true" />;
  if (action === "create_post") return <Megaphone className={className} aria-hidden="true" />;
  if (action === "create_list_item") return <ListPlus className={className} aria-hidden="true" />;
  return <BellRing className={className} aria-hidden="true" />;
}

const DATE_KEYS = ["startsAt", "starts_at", "endsAt", "ends_at", "remindAt", "remind_at", "dueAt", "due_at"];

function splitDateTime(iso: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  if (match === null) return null;
  return { date: match[1] ?? "", time: match[2] ?? "" };
}

function joinDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hhmm = /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
  const local = new Date(`${date}T${hhmm}:00`);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

type ItemDraft = {
  include: boolean;
  title: string;
  date: string;
  time: string;
  /** "" = sin tocar; "none" = solo yo/quitar; uid = responsable. */
  assignee: string;
  projectId: string;
};

function draftFromParams(params: Record<string, unknown>): ItemDraft {
  const title = typeof params["title"] === "string" || typeof params["text"] === "string"
    ? String(params["title"] ?? params["text"] ?? "")
    : "";
  let date = "";
  let time = "";
  for (const key of DATE_KEYS) {
    const raw = params[key];
    if (typeof raw === "string") {
      const split = splitDateTime(raw);
      if (split !== null) {
        date = split.date;
        time = split.time;
        break;
      }
    }
  }
  const rawAssignees = params["assigneeIds"] ?? params["assignee_ids"];
  const assignee = Array.isArray(rawAssignees) && typeof rawAssignees[0] === "string"
    ? rawAssignees[0] as string
    : "";
  const projectId = typeof params["projectId"] === "string" || typeof params["project_id"] === "string"
    ? String(params["projectId"] ?? params["project_id"] ?? "")
    : "";
  return { include: true, title, date, time, assignee, projectId };
}

function applyDraft(
  params: Record<string, unknown>,
  draft: ItemDraft,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  if ("title" in next) next["title"] = draft.title;
  if ("text" in next && !("title" in next)) next["text"] = draft.title;
  if (draft.date !== "") {
    const iso = joinDateTime(draft.date, draft.time);
    if (iso !== null) {
      for (const key of DATE_KEYS) {
        if (key in next) next[key] = iso;
      }
      // Si no había fecha (p. ej. tarea) y el usuario puso una, va a dueAt
      // en tareas y a startsAt en eventos/recordatorios.
      if (!DATE_KEYS.some((key) => key in params)) {
        next["dueAt"] = iso;
      }
    }
  }
  if (draft.assignee !== "") {
    next["assigneeIds"] = draft.assignee === "none" ? [] : [draft.assignee];
  }
  if (draft.projectId !== "") {
    if ("projectId" in next || !("project_id" in next)) next["projectId"] = draft.projectId;
    else next["project_id"] = draft.projectId;
  }
  return next;
}

const inputClass =
  "h-11 w-full rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none";
const labelClass = "block text-meta leading-4 text-muted-foreground";

/**
 * Tarjeta de confirmación para acciones de Loki IA.
 * - Una acción: resumen + edición compacta (título, fecha/hora, responsable,
 *   proyecto) + Confirmar/Cancelar.
 * - Plan: lista con casilla por acción, cada una editable.
 * Todo táctil ≥44px, apilado en 360px; Enter confirma y Escape cancela.
 */
export function AiToolCard({
  pending,
  sending,
  members,
  projects,
  workspaces,
  initialWorkspaceId,
  onConfirm,
  onCancel,
}: {
  pending: AiPendingAction;
  sending: boolean;
  members: CardMember[];
  projects: CardProject[];
  workspaces?: CardWorkspace[];
  initialWorkspaceId?: string;
  onConfirm: (payload: CardConfirmPayload) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const items: AiPendingItem[] = React.useMemo(
    () =>
      pending.actions !== undefined && pending.actions.length > 0
        ? pending.actions
        : [{ action: pending.action, label: pending.label, params: pending.params, include: true }],
    [pending],
  );
  const isPlan = pending.actions !== undefined && pending.actions.length > 0;
  const [drafts, setDrafts] = React.useState<ItemDraft[]>(() =>
    items.map((item) => ({
      ...draftFromParams(item.params),
      include: item.include,
    })),
  );
  const [workspaceId, setWorkspaceId] = React.useState(initialWorkspaceId ?? "");

  React.useEffect(() => {
    setDrafts(items.map((item) => ({ ...draftFromParams(item.params), include: item.include })));
  }, [pending.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function setDraft(index: number, patch: Partial<ItemDraft>): void {
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  function handleConfirm(): void {
    if (sending) return;
    void (async () => {
      try {
        const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
        await Haptics.impact({ style: ImpactStyle.Light });
      } catch {
        // Web sin hápticos: se confirma igual.
      }
    })();
    if (isPlan) {
      onConfirm({
        actions: items.map((item, index) => {
          const draft = drafts[index] ?? draftFromParams(item.params);
          return {
            action: item.action,
            params: applyDraft(item.params, draft),
            include: draft.include,
          };
        }),
        params: pending.params,
        ...(workspaceId !== "" ? { workspaceId } : {}),
      });
      return;
    }
    const draft = drafts[0] ?? draftFromParams(pending.params);
    onConfirm({
      params: applyDraft(pending.params, draft),
      ...(workspaceId !== "" ? { workspaceId } : {}),
    });
  }

  // Enter confirma y Escape cancela cuando el foco está en la tarjeta
  // (en un select el Enter lo maneja el propio desplegable).
  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      handleConfirm();
    }
  }

  const assigneeOptions = pending.assigneeChoices ?? members;
  const showAssignee = assigneeOptions.length > 0;
  const showProject = projects.length > 0;

  return (
    <div
      role="group"
      aria-label={`Confirmar: ${pending.label}`}
      onKeyDown={handleKey}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <ActionIcon action={pending.action} />
        <p className="text-body-sm font-semibold text-foreground">{pending.label}</p>
      </div>

      {workspaces !== undefined && workspaces.length > 1 ? (
        <label className="flex min-h-11 flex-col justify-center gap-1">
          <span className={labelClass}>Espacio</span>
          <select
            aria-label="Espacio donde se crea"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            className={cn(inputClass, "min-h-11")}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <ul className="flex flex-col gap-3">
        {items.map((item, index) => {
          const draft = drafts[index] ?? draftFromParams(item.params);
          return (
            <li
              key={`${item.action}-${index}`}
              className={cn(
                "flex flex-col gap-2 rounded-xl p-2",
                isPlan && "border border-divider",
                !draft.include && "opacity-60",
              )}
            >
              <div className="flex items-center gap-2">
                {isPlan ? (
                  <input
                    type="checkbox"
                    aria-label={`Incluir: ${item.label}`}
                    checked={draft.include}
                    disabled={item.warning !== undefined}
                    onChange={(event) => setDraft(index, { include: event.target.checked })}
                    className="h-6 w-6 shrink-0 accent-[var(--accent)]"
                  />
                ) : null}
                <ActionIcon action={item.action} />
                <p className="min-w-0 flex-1 truncate text-body-sm font-semibold text-foreground">
                  {item.label}
                </p>
              </div>
              {item.warning !== undefined ? (
                <p role="alert" className="text-body-sm leading-5 text-danger">
                  {item.warning}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>
                      <Pencil className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      Título
                    </span>
                    <input
                      type="text"
                      aria-label="Título"
                      value={draft.title}
                      onChange={(event) => setDraft(index, { title: event.target.value })}
                      maxLength={200}
                      className={cn(inputClass, "min-h-11")}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Fecha</span>
                      <input
                        type="date"
                        aria-label="Fecha"
                        value={draft.date}
                        onChange={(event) => setDraft(index, { date: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Hora</span>
                      <input
                        type="time"
                        aria-label="Hora"
                        value={draft.time}
                        onChange={(event) => setDraft(index, { time: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {showAssignee ? (
                      <label className="flex flex-col gap-1">
                        <span className={labelClass}>Responsable</span>
                        <select
                          aria-label="Responsable"
                          value={draft.assignee}
                          onChange={(event) => setDraft(index, { assignee: event.target.value })}
                          className={cn(inputClass, "min-h-11")}
                        >
                          <option value="">Sin cambio</option>
                          <option value="none">Solo yo</option>
                          {assigneeOptions.map((member) => (
                            <option key={member.uid} value={member.uid}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {showProject && (item.action === "create_task" || item.action === "create_reminder" || item.action === "update_task") ? (
                      <label className="flex flex-col gap-1">
                        <span className={labelClass}>Proyecto</span>
                        <select
                          aria-label="Proyecto"
                          value={draft.projectId}
                          onChange={(event) => setDraft(index, { projectId: event.target.value })}
                          className={cn(inputClass, "min-h-11")}
                        >
                          <option value="">Bandeja</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.isSystem ? "📥 " : ""}{project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={sending}
          onClick={handleConfirm}
          className="min-h-11 flex-1 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {sending ? "Enviando…" : "Confirmar"}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={onCancel}
          className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Barra de "Deshacer" tras ejecutar: vive unos segundos y borra lo creado
 * (tarea, evento o aviso) con el propio usuario.
 */
export function UndoBar({
  items,
  onUndo,
  onDone,
  seconds = 30,
}: {
  items: UndoItem[];
  onUndo: (items: UndoItem[]) => void;
  onDone: () => void;
  seconds?: number;
}): React.JSX.Element | null {
  const [left, setLeft] = React.useState(seconds);

  React.useEffect(() => {
    setLeft(seconds);
    const timer = setInterval(() => {
      setLeft((value) => {
        if (value <= 1) {
          clearInterval(timer);
          onDone();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [items, seconds, onDone]);

  if (items.length === 0 || left <= 0) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto flex min-h-11 w-full items-center gap-2 rounded-2xl bg-foreground px-4 py-2 text-background shadow-overlay dark:bg-white dark:text-black"
    >
      <span className="min-w-0 flex-1 truncate text-body-sm">
        Creado · se puede deshacer ({left}s)
      </span>
      <button
        type="button"
        onClick={() => {
          onUndo(items);
          onDone();
        }}
        className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-body-sm font-semibold outline-none interactive"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        Deshacer
      </button>
    </div>
  );
}
