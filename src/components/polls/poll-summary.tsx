"use client";

import * as React from "react";
import { Sparkles, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { AiJobStatus } from "@/components/ai/job-status";
import {
  findLatestPollSummaryJob,
  getAiJob,
  getAiJobResult,
  listenAiJob,
  requestAiJob,
  type AiJob,
} from "@/lib/data/ai-jobs";
import { getLokiStatus } from "@/lib/ai/loki";
import { useSessionStore } from "@/stores/session-store";
import type { PollView } from "@/types/organizer";

/** Aviso único cuando no hay modelo configurado (nada se encola). */
const NOT_CONFIGURED = "Loki IA sin configurar. El resultado ya está en las barras.";

type SummaryState =
  | { state: "inactivo" }
  | { state: "preparando" }
  | { state: "trabajando"; job: AiJob }
  | { state: "listo"; summary: string; detail: string; deterministic: boolean }
  | { state: "error"; message: string };

/**
 * "Resumir con Loki" sobre una encuesta, SOLO bajo pedido.
 *
 * No hay nada corriendo hasta que alguien lo pide: entonces se encola un
 * trabajo de tipo `poll_summary` (el trigger `wake_ai_worker` despierta a
 * `loki-worker` por `pg_net`) y el estado llega por Realtime sobre la fila.
 * El worker arma el resultado con SQL (código, no IA) y solo si hay modelo le
 * pide una lectura corta, reservando la cuota del espacio antes de llamar.
 *
 * Si esta persona ya pidió el resumen de esta encuesta, se reutiliza el
 * trabajo anterior (no se vuelve a pagar). Sin modelo no se encola nada: se
 * avisa y las barras de la tarjeta ya muestran el resultado.
 */
export function PollSummary({
  poll,
  onClose,
}: {
  /** La encuesta ya está en pantalla: se reutiliza su estado (sin otra
   *  suscripción a Realtime) y solo se usa su id y su espacio. */
  poll: PollView;
  onClose: () => void;
}): React.JSX.Element {
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const pollId = poll.id;
  const wsId = poll.workspaceId;
  const [value, setValue] = React.useState<SummaryState>({ state: "inactivo" });
  const tokenRef = React.useRef(0);
  // Un solo intento de lectura por trabajo (el callback de Realtime puede
  // llegar varias veces con el mismo estado).
  const readRef = React.useRef("");

  // Lee `ai_jobs.result` y lo pasa a la UI en español.
  const readResult = React.useCallback(
    async (jobId: string, token: number): Promise<void> => {
      const result = await getAiJobResult(jobId).catch(() => null);
      if (tokenRef.current !== token || result === null) return;
      setValue({
        state: "listo",
        summary: typeof result["summary"] === "string" ? result["summary"] : "",
        detail: typeof result["detail"] === "string" ? result["detail"] : "",
        deterministic: result["deterministic"] === true,
      });
    },
    [],
  );

  // El trabajo en vuelo se mira por Realtime (sin bucles: solo mientras hay
  // algo que esperar y mientras este panel está abierto).
  const jobId = value.state === "trabajando" ? value.job.id : "";
  React.useEffect(() => {
    if (jobId === "") return;
    const token = tokenRef.current;
    if (readRef.current === jobId) return;
    const stop = listenAiJob(jobId, (next) => {
      if (tokenRef.current !== token || next === null) return;
      if (next.status === "done") {
        readRef.current = jobId;
        void readResult(jobId, token);
      } else if (next.status === "error") {
        setValue({ state: "error", message: next.error ?? "No se pudo resumir la encuesta." });
      } else if (next.status === "cancelled") {
        setValue({ state: "error", message: "El resumen se canceló." });
      }
    });
    return stop;
  }, [jobId, readResult]);

  const start = React.useCallback(async (): Promise<void> => {
    if (uid === null || wsId === "") return;
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    readRef.current = "";
    setValue({ state: "preparando" });
    try {
      const health = await getLokiStatus();
      if (tokenRef.current !== token) return;
      if (!health.configured) {
        setValue({ state: "error", message: NOT_CONFIGURED });
        return;
      }
      // Reutiliza el trabajo anterior de esta persona (no se vuelve a pagar).
      const previous = await findLatestPollSummaryJob(wsId, pollId, uid);
      if (tokenRef.current !== token) return;
      if (previous !== null && (previous.status === "queued" || previous.status === "running")) {
        setValue({ state: "trabajando", job: previous });
        return;
      }
      if (previous !== null && previous.status === "done") {
        setValue({ state: "trabajando", job: previous });
        readRef.current = "";
        await readResult(previous.id, token);
        return;
      }
      const createdId = await requestAiJob(wsId, uid, "poll_summary", { poll_id: pollId });
      if (tokenRef.current !== token) return;
      const row = (await getAiJob(createdId).catch(() => null)) ?? {
        id: createdId,
        workspaceId: wsId,
        requestedBy: uid,
        type: "poll_summary",
        status: "queued",
        attempts: 0,
        error: null,
        createdAt: new Date().toISOString(),
      };
      setValue({ state: "trabajando", job: row });
    } catch (error: unknown) {
      if (tokenRef.current !== token) return;
      setValue({
        state: "error",
        message: error instanceof Error ? error.message : "No se pudo pedir el resumen.",
      });
    }
  }, [pollId, readResult, uid, wsId]);

  async function handleRetry(): Promise<void> {
    await start();
  }

  const working = value.state === "trabajando" ? value.job : null;

  return (
    <section
      aria-label="Resumen de la encuesta"
      className="flex flex-col gap-2 rounded-xs border border-dashed border-accent/50 p-2"
    >
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={20} aria-hidden="true" className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-meta font-semibold leading-4 text-foreground">
          Resumen de Loki
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar resumen"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
        >
          <Icon icon={X} size={20} />
        </button>
      </div>

      {value.state === "preparando" ? (
        <p role="status" className="text-meta leading-4 text-muted-foreground">
          Preparando el resumen…
        </p>
      ) : null}

      {working !== null ? (
        <div className="flex flex-col gap-1">
          <AiJobStatus job={working} onRetry={() => void start()} />
          <p className="text-meta leading-4 text-muted-foreground">
            Loki está leyendo el resultado y las opiniones del hilo.
          </p>
        </div>
      ) : null}

      {value.state === "listo" ? (
        <div className="flex flex-col gap-1">
          {value.summary !== "" ? (
            <p className="whitespace-pre-wrap text-body-sm leading-5 text-foreground">
              {value.summary}
            </p>
          ) : (
            <p className="text-meta leading-4 text-muted-foreground">
              Solo las cifras (sin modelo):
            </p>
          )}
          {value.detail !== "" ? (
            <p className="whitespace-pre-wrap break-words text-meta leading-4 text-muted-foreground">
              {value.detail}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void start()}
            className="self-start text-meta font-semibold leading-4 text-accent outline-none interactive"
          >
            {value.deterministic ? "Intentar con Loki" : "Actualizar"}
          </button>
        </div>
      ) : null}

      {value.state === "error" ? (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-meta leading-4 text-danger">
            {value.message}
          </p>
          <button
            type="button"
            onClick={() => void handleRetry()}
            className="self-start text-meta font-semibold leading-4 text-accent outline-none interactive"
          >
            Reintentar
          </button>
        </div>
      ) : null}
    </section>
  );
}
