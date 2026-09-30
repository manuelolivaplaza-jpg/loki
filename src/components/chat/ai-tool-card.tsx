"use client";

import * as React from "react";
import { CalendarPlus, CheckCircle2, ListPlus, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AiPendingAction } from "@/lib/ai/tools-client";
import { cn } from "@/lib/utils";

/** Icono por acción de escritura (solo decorativo). */
function ActionIcon({ action }: { action: string }): React.JSX.Element {
  const className = "h-5 w-5 shrink-0 text-primary";
  if (action === "create_event") return <CalendarPlus className={className} aria-hidden="true" />;
  if (action === "create_task") return <ListPlus className={className} aria-hidden="true" />;
  if (action === "complete_task") return <CheckCircle2 className={className} aria-hidden="true" />;
  return <BellRing className={className} aria-hidden="true" />;
}

/** Etiquetas en español para los parámetros conocidos (el resto va crudo). */
const PARAM_LABELS: Record<string, string> = {
  title: "Título",
  startsAt: "Inicio",
  starts_at: "Inicio",
  endsAt: "Fin",
  ends_at: "Fin",
  location: "Ubicación",
  description: "Descripción",
  projectId: "Proyecto",
  project_id: "Proyecto",
  dueAt: "Vence",
  due_at: "Vence",
  notes: "Notas",
  taskId: "Tarea",
  task_id: "Tarea",
  remindAt: "Aviso",
  remind_at: "Aviso",
};

/** Parámetros técnicos que no se muestran (ya los pone el contexto). */
const HIDDEN_PARAMS: ReadonlySet<string> = new Set(["workspaceId", "chatId"]);

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const date = new Date(parsed);
      const text = date.toLocaleString("es-CL", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${value.length <= 10 ? text.split(",")[0] ?? text : text} (${value.slice(0, 16).replace("T", " ")})`;
    }
    return value.length > 140 ? `${value.slice(0, 140)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "—";
  try {
    const text = JSON.stringify(value);
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  } catch {
    return "—";
  }
}

type AiToolCardProps = {
  pending: AiPendingAction;
  sending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Tarjeta de confirmación para acciones de Loki IA que modifican datos.
 * Resume los parámetros en español y pide Confirmar o Cancelar.
 */
export function AiToolCard(
  { pending, sending, onConfirm, onCancel }: AiToolCardProps,
): React.JSX.Element {
  const rows = React.useMemo(
    () =>
      Object.entries(pending.params).filter(
        ([key, value]) =>
          !HIDDEN_PARAMS.has(key) && value !== null && value !== undefined && value !== "",
      ),
    [pending.params],
  );
  return (
    <div
      role="group"
      aria-label={`Confirmar: ${pending.label}`}
      className={cn(
        "rounded-2xl border border-border bg-card p-3 shadow-sm",
        "flex flex-col gap-2",
      )}
    >
      <div className="flex items-center gap-2">
        <ActionIcon action={pending.action} />
        <p className="text-body-sm font-semibold text-foreground">{pending.label}</p>
      </div>
      {rows.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {rows.map(([key, value]) => (
            <div key={key} className="flex gap-2 text-body-sm">
              <dt className="shrink-0 text-muted-foreground">
                {PARAM_LABELS[key] ?? key}:
              </dt>
              <dd className="min-w-0 break-words text-foreground">
                {formatValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          Loki quiere hacer esto en tu espacio.
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          disabled={sending}
          onClick={onConfirm}
        >
          {sending ? "Enviando…" : "Confirmar"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={sending}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
