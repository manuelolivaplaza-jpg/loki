"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { AiJob } from "@/lib/data/ai-jobs";
import { listenAiJob, retryAiJob } from "@/lib/data/ai-jobs";

const STATUS_TEXT: Record<AiJob["status"], string> = {
  queued: "En cola",
  running: "Procesando",
  done: "Listo",
  error: "Falló",
  cancelled: "Cancelado",
};

/**
 * Estado pequeño de un trabajo de IA: sirve dentro de burbujas de chat,
 * hojas móviles y paneles de escritorio. En error muestra Reintentar.
 */
export function AiJobStatus({
  job,
  onRetry,
}: {
  job: AiJob;
  onRetry?: () => void;
}): React.JSX.Element {
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);

  async function handleRetry(): Promise<void> {
    if (onRetry !== undefined) {
      onRetry();
      return;
    }
    setRetrying(true);
    setRetryError(null);
    try {
      await retryAiJob(job.id);
    } catch {
      setRetryError("No se pudo reintentar.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta leading-4",
          job.status === "done" && "bg-success/15 text-success",
          job.status === "error" && "bg-danger/15 text-danger",
          (job.status === "queued" || job.status === "running" || job.status === "cancelled") &&
            "bg-surface text-muted-foreground",
        )}
      >
        <Icon
          icon={
            job.status === "done"
              ? CheckCircle2
              : job.status === "error"
                ? AlertTriangle
                : job.status === "running"
                  ? Loader2
                  : Clock3
          }
          size={20}
        />
        {STATUS_TEXT[job.status]}
      </span>
      {job.status === "error" ? (
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={retrying}
          className="text-meta font-semibold leading-4 text-mention outline-none interactive disabled:opacity-60"
        >
          {retrying ? "Reintentando…" : "Reintentar"}
        </button>
      ) : null}
      {retryError !== null ? (
        <span role="alert" className="text-meta leading-4 text-danger">
          {retryError}
        </span>
      ) : null}
    </span>
  );
}

/** Versión viva: suscribe el trabajo por Realtime (sin bucles). */
export function AiJobStatusLive({ jobId }: { jobId: string }): React.JSX.Element | null {
  const [job, setJob] = React.useState<AiJob | null>(null);

  React.useEffect(() => {
    if (jobId === "") return;
    const stop = listenAiJob(jobId, setJob);
    return stop;
  }, [jobId]);

  if (job === null) return null;
  return <AiJobStatus job={job} />;
}
