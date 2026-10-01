"use client";

import * as React from "react";
import { Copy, FileAudio, Loader2, RefreshCw, Type, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { SafeText } from "@/components/chat/safe-text";
import { splitMediaPath } from "@/lib/media/upload";
import {
  findTranscription,
  getSttHealth,
  listenTranscription,
  requestTranscription,
  retryTranscription,
  TRANSCRIPTION_NOT_CONFIGURED,
  type AudioTranscription,
} from "@/lib/data/transcriptions";
import type { MessageAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

/**
 * Cerrado    -> botón "Ver transcripción" (y NINGUNA consulta: no hay
 *              suscripción, ni fetch, ni trabajo encolado).
 * preparando -> skeleton mientras se lee si ya existía.
 * pidiendo   -> se encoló el trabajo; el texto llega por Realtime.
 * listo      -> el texto (con SafeText: nunca HTML).
 * error      -> motivo en español + Reintentar (salvo que falte el proveedor:
 *              ahí no tiene sentido reintentar, se avisa de la config).
 */
type PanelPhase = "cerrado" | "preparando" | "pidiendo" | "listo" | "error";

type VoiceProps = {
  attachment: MessageAttachment;
  /** Mensaje que lleva la nota: la transcripción hereda su visibilidad. */
  messageId: string;
  chatId: string;
  authorId: string | null;
  /** Espacios de la burbuja propia (oscura): texto claro. */
  dark?: boolean;
};

/**
 * Transcripción de una nota de voz, BAJO DEMANDA.
 *
 * Nada se pide hasta que alguien toca "Ver transcripción". En ese momento:
 *   1. se busca si ya existía (un archivo, una transcripción: no seRepite);
 *   2. sin proveedor, se avisa "Transcripción sin configurar" y NO se encola;
 *   3. si no, se inserta la fila; el trigger de Postgres mete el trabajo en
 *      `ai_jobs` y despierta a `loki-worker` por `pg_net`;
 *   4. el texto llega por Realtime sobre esa fila.
 *
 * Se usa igual dentro de la burbuja propia (oscura) y en la de otro.
 */
export function VoiceTranscription(props: VoiceProps): React.JSX.Element | null {
  const { attachment, messageId, chatId, authorId, dark = false } = props;
  // La ruta del adjunto (`{bucket}/{wsId}/{uuid}-{nombre}`) es lo que permite
  // transcribir sin volver a subir el audio. Sin ella no se puede.
  const target = React.useMemo(() => splitMediaPath(attachment.path), [attachment.path]);
  const [phase, setPhase] = React.useState<PanelPhase>("cerrado");
  const [row, setRow] = React.useState<AudioTranscription | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sinProveedor, setSinProveedor] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  /** Corta cualquier petición en vuelo al cambiar de mensaje. */
  const requestRef = React.useRef(0);

  // Cambia de mensaje o de archivo: se cierra el panel y se suelta lo que
  // estuviera en vuelo (nada de estados colgados ni suscripciones huérfanas).
  React.useEffect(() => {
    requestRef.current += 1;
    setPhase("cerrado");
    setRow(null);
    setError(null);
    setSinProveedor(false);
  }, [messageId, attachment.path]);

  const abrir = React.useCallback(async () => {
    if (target === null) return;
    setPhase("preparando");
    setError(null);
    setSinProveedor(false);
    const token = requestRef.current + 1;
    requestRef.current = token;

    // 1) ¿Ya estaba transcrito? (si sí, no se vuelve a pagar)
    const existing = await findTranscription(target.workspaceId, target.objectPath).catch(
      () => null,
    );
    if (requestRef.current !== token) return;
    if (existing !== null) {
      setRow(existing);
      if (existing.status === "ready" && existing.text !== "") {
        setPhase("listo");
        return;
      }
      if (existing.status === "error") {
        setError(existing.error ?? "No se pudo transcribir.");
        setPhase("error");
        return;
      }
      // pending/running: alguien la pidió antes, solo falta mirar.
      setPhase("pidiendo");
      return;
    }

    // 2) ¿Hay proveedor? (sin él no se encola nada ni se sube el audio fuera)
    const stt = await getSttHealth();
    if (requestRef.current !== token) return;
    if (!stt.configured) {
      setSinProveedor(true);
      setError(TRANSCRIPTION_NOT_CONFIGURED);
      setPhase("error");
      return;
    }

    // 3) Encolar. La base se encarga de despertar al worker.
    setBusy(true);
    try {
      const created = await requestTranscription({
        workspaceId: target.workspaceId,
        bucket: target.bucket,
        objectPath: target.objectPath,
        messageId,
        chatId,
        authorId,
        ...(attachment.duration !== undefined ? { durationSeconds: attachment.duration } : {}),
      });
      if (requestRef.current !== token) return;
      setRow(created);
      if (created.status === "error") {
        setError(created.error ?? "No se pudo transcribir.");
        setPhase("error");
        return;
      }
      setPhase("pidiendo");
    } catch (err: unknown) {
      if (requestRef.current !== token) return;
      setError(err instanceof Error ? err.message : "No se pudo pedir la transcripción.");
      setPhase("error");
    } finally {
      if (requestRef.current === token) setBusy(false);
    }
  }, [target, messageId, chatId, authorId, attachment.duration]);

  // Estado en vivo SOLO con el panel abierto: cerrado no hay ni una consulta.
  React.useEffect(() => {
    if (target === null || phase !== "pidiendo") return;
    const stop = listenTranscription(target.workspaceId, target.objectPath, (next) => {
      if (next === null) return;
      setRow(next);
      if (next.status === "ready" && next.text !== "") {
        setPhase("listo");
      } else if (next.status === "error") {
        setError(next.error ?? "No se pudo transcribir.");
        setPhase("error");
      }
    });
    return stop;
  }, [target, phase]);

  const reintentar = React.useCallback(async () => {
    if (row === null) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await retryTranscription(row.id);
      if (!ok) {
        setError("No se pudo reintentar todavía.");
        return;
      }
      setRow({ ...row, status: "pending", error: null });
      setPhase("pidiendo");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo reintentar.");
    } finally {
      setBusy(false);
    }
  }, [row]);

  // Sin ruta de Storage no hay nada que transcribir (mensajes antiguos sin
  // `path`, o un adjunto que no vino de nuestros buckets).
  if (target === null) return null;

  const labelCls = dark ? "text-white/70" : "text-muted-foreground";
  const textCls = dark ? "text-white" : "text-foreground";
  const btnCls = dark ? "text-white/85 active:bg-white/15" : "text-accent active:bg-surface-soft";

  if (phase === "cerrado") {
    return (
      <button
        type="button"
        onClick={() => void abrir()}
        aria-expanded={false}
        aria-label="Ver transcripción de la nota de voz"
        className={cn(
          "mt-0.5 flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-meta font-semibold outline-none interactive",
          labelCls,
        )}
      >
        <Icon icon={Type} size={20} />
        Ver transcripción
      </button>
    );
  }

  const heading =
    phase === "preparando"
      ? "Buscando transcripción…"
      : phase === "pidiendo"
        ? "Transcribiendo…"
        : phase === "listo"
          ? "Transcripción"
          : "No se pudo transcribir";

  return (
    <div
      className={cn("mt-1 rounded-xl px-2.5 py-2", dark ? "bg-white/10" : "bg-surface-soft")}
      role="group"
      aria-label="Transcripción de la nota de voz"
    >
      <div className="flex items-center gap-1.5">
        <Icon icon={phase === "listo" ? Type : FileAudio} size={20} className={labelCls} />
        <p className={cn("min-w-0 flex-1 truncate text-meta font-semibold", labelCls)}>
          {heading}
        </p>
        {phase === "preparando" || phase === "pidiendo" ? (
          <Icon icon={Loader2} size={20} className={cn("animate-spin", labelCls)} />
        ) : null}
        {phase === "listo" ? (
          <button
            type="button"
            onClick={() => {
              const text = row?.text ?? "";
              if (text === "" || typeof navigator === "undefined" || !navigator.clipboard) return;
              void navigator.clipboard.writeText(text).catch(() => undefined);
            }}
            aria-label="Copiar transcripción"
            title="Copiar transcripción"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none interactive",
              btnCls,
            )}
          >
            <Icon icon={Copy} size={20} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setPhase("cerrado")}
          aria-label="Cerrar transcripción"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none interactive",
            btnCls,
          )}
        >
          <Icon icon={X} size={20} />
        </button>
      </div>

      {phase === "preparando" ? (
        <div aria-hidden="true" className="mt-1.5 flex flex-col gap-1">
          <span className={cn("h-3 w-4/5 animate-pulse rounded-full opacity-25", dark ? "bg-white" : "bg-foreground")} />
          <span className={cn("h-3 w-3/5 animate-pulse rounded-full opacity-25", dark ? "bg-white" : "bg-foreground")} />
        </div>
      ) : null}

      {phase === "listo" ? (
        <p className={cn("mt-1 whitespace-pre-wrap break-words text-body-sm leading-5", textCls)}>
          <SafeText text={row?.text ?? ""} />
        </p>
      ) : null}

      {phase === "error" ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className={cn("text-body-sm leading-5", dark ? "text-white/90" : "text-danger")}>
            {error ?? "No se pudo transcribir."}
          </p>
          {sinProveedor ? (
            <p className={cn("text-meta leading-4", labelCls)}>
              Pide al administrador que configure el proveedor de voz a texto
              (STT_API_KEY en las Edge Functions).
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void reintentar()}
              disabled={busy || row === null}
              className={cn(
                "flex min-h-11 items-center gap-1.5 self-start rounded-full px-3 text-body-sm font-semibold outline-none interactive disabled:opacity-60",
                btnCls,
              )}
            >
              <Icon icon={RefreshCw} size={20} />
              {busy ? "Reintentando…" : "Reintentar"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
