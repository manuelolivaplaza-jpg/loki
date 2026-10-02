"use client";

import * as React from "react";
import { Brain, ListPlus, RefreshCw, Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { AiJobStatusLive } from "@/components/ai/job-status";
import { cn } from "@/lib/utils";

export type DigestPoint = { text: string; msg: string };

export type ChatDigest = {
  points: DigestPoint[];
  decisions: string[];
  questions: string[];
  mentions: string[];
};

/**
 * Tarjeta PRIVADA del resumen de no leídos: solo la ve quien lo pidió (no
 * se publica en el chat). Puntos clave con enlace al mensaje, decisiones,
 * preguntas pendientes y menciones. Cada punto se puede convertir en tarea.
 */
export function DigestPanel({
  digest,
  cached,
  refreshing,
  onConvertPoint,
  onRememberPoint,
  onRefresh,
}: {
  digest: ChatDigest;
  cached: boolean;
  refreshing: boolean;
  onConvertPoint: (title: string) => void;
  /**
   * Propone un punto del resumen como recuerdo de la memoria del espacio.
   * Nunca guarda nada por su cuenta: abre la hoja para que alguien confirme.
   */
  onRememberPoint: (title: string) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-label="Resumen de no leídos"
      className="flex flex-col gap-2 rounded-2xl border border-dashed border-accent/50 bg-card p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={20} aria-hidden="true" className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-foreground">
          Lo que te perdiste{cached ? " (guardado)" : ""}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Actualizar resumen"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-60"
        >
          <Icon icon={RefreshCw} size={20} />
        </button>
      </div>
      <p className="text-meta leading-4 text-muted-foreground">
        Solo tú ves esto. No se publicó en el chat.
      </p>
      {digest.points.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {digest.points.map((point, index) => (
            <li key={`${point.msg}-${index}`} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 text-body-sm leading-5 text-foreground">
                {point.text}
              </span>
              <button
                type="button"
                onClick={() => onRememberPoint(point.text)}
                aria-label={`Recordar en el espacio: ${point.text.slice(0, 60)}`}
                title="Recordar en el espacio"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
              >
                <Icon icon={Brain} size={20} />
              </button>
              <button
                type="button"
                onClick={() => onConvertPoint(point.text)}
                aria-label={`Crear tarea: ${point.text.slice(0, 60)}`}
                title="Crear tarea"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
              >
                <Icon icon={ListPlus} size={20} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">Nada relevante.</p>
      )}
      {digest.decisions.length > 0 ? (
        <div>
          <p className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
            Decisiones
          </p>
          <ul className="flex flex-col gap-1 pt-1">
            {digest.decisions.map((decision, index) => (
              <li key={index} className="text-body-sm leading-5 text-foreground">
                · {decision}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {digest.questions.length > 0 ? (
        <div>
          <p className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
            Pendientes
          </p>
          <ul className="flex flex-col gap-1 pt-1">
            {digest.questions.map((question, index) => (
              <li key={index} className="text-body-sm leading-5 text-foreground">
                · {question}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {digest.mentions.length > 0 ? (
        <p className="text-body-sm leading-5 text-mention">
          Te mencionaron: {digest.mentions.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

/** Pastilla "Resumir N con Loki" junto a la de nuevos mensajes. */
export function DigestPill({
  count,
  disabled,
  disabledReason,
  onClick,
}: {
  count: number;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      aria-label={disabled ? disabledReason : `Resumir ${count} mensajes con Loki`}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background shadow-float outline-none dark:bg-white dark:text-black",
        "disabled:opacity-60",
      )}
    >
      <Icon icon={Sparkles} size={20} />
      {disabled ? (disabledReason ?? "Loki IA sin configurar") : `Resumir ${count} con Loki`}
    </button>
  );
}

/** Estado del trabajo de resumen (reutiliza el componente de jobs). */
export function DigestJobStatus({ jobId }: { jobId: string }): React.JSX.Element {
  return <AiJobStatusLive jobId={jobId} />;
}
