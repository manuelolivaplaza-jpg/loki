"use client";

import * as React from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAgentRun, useAgentMutations } from "@/hooks/use-agents";
import { AGENT_RUN_STATUS_LABEL } from "@/types/agents";
import { cn } from "@/lib/utils";

/**
 * Estado en vivo de una ejecución de prueba (kind ping): queued →
 * dispatched → running → done, con cada paso visible. El progreso llega por
 * Realtime (más un reintento de consulta cada 3 s mientras viva).
 */
export function AgentPingStatus(props: {
  runId: string;
  uid: string | null;
  onDone?: () => void;
}): React.JSX.Element {
  const { runId, uid, onDone } = props;
  const { run, events, isPending, error, retry } = useAgentRun(runId);
  const mutations = useAgentMutations(uid);
  const doneNotified = React.useRef(false);

  const status = run?.status ?? "queued";
  const finished = status === "done" || status === "error" ||
    status === "cancelled" || status === "expired";
  React.useEffect(() => {
    if (finished && !doneNotified.current) {
      doneNotified.current = true;
      onDone?.();
    }
  }, [finished, onDone]);

  const steps = [
    { key: "dispatched", label: "Pedido enviado al agente" },
    { key: "running", label: "El agente despertó" },
    { key: "done", label: "Respuesta válida recibida" },
  ] as const;
  const order: Record<string, number> = {
    queued: 0,
    dispatched: 1,
    running: 2,
    needs_input: 2,
    done: 3,
    error: 3,
    cancelled: 3,
    expired: 3,
  };
  const reached = order[status] ?? 0;
  const failed = status === "error" || status === "expired" || status === "cancelled";
  const lastEvent = events.length > 0 ? events[events.length - 1]?.text ?? null : null;

  async function handleCancel(): Promise<void> {
    try {
      await mutations.cancelRun(runId);
    } catch {
      // El error ya quedó en mutations.error.
    }
  }

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 text-body-sm text-muted-foreground">
        <Icon icon={Loader2} size={16} className="animate-spin" />
        Iniciando la prueba…
      </p>
    );
  }
  if (error !== null) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-body-sm text-danger">{error}</p>
        <Button type="button" variant="secondary" onClick={retry} className="w-full">
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, index) => {
          const done = reached > index + 1 || (status === "done" && index === 2);
          const current = !finished && reached === index + 1;
          const stepFailed = failed && reached === index + 1;
          return (
            <li key={step.key} className="flex items-center gap-2 text-body-sm">
              {done ? (
                <Icon icon={Check} size={16} className="shrink-0 text-success" />
              ) : stepFailed ? (
                <Icon icon={X} size={16} className="shrink-0 text-danger" />
              ) : current ? (
                <Icon icon={Loader2} size={16} className="shrink-0 animate-spin text-accent" />
              ) : (
                <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full border border-border" />
              )}
              <span className={cn(done ? "text-foreground" : "text-muted-foreground")}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
      {run !== null ? (
        <p className="text-body-sm text-muted-foreground">
          Estado: {AGENT_RUN_STATUS_LABEL[run.status]}
          {lastEvent !== null && lastEvent !== "" ? ` · ${lastEvent}` : null}
        </p>
      ) : null}
      {run?.error !== null && run?.error !== undefined && run.error !== "" ? (
        <p role="alert" className="text-body-sm leading-5 text-danger">{run.error}</p>
      ) : null}
      {!finished ? (
        <Button
          type="button"
          variant="secondary"
          disabled={mutations.saving}
          onClick={() => void handleCancel()}
          className="w-full"
        >
          Cancelar prueba
        </Button>
      ) : null}
    </div>
  );
}
