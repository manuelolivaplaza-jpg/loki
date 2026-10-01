"use client";

import * as React from "react";
import { FileAudio, Loader2, Mic, Sparkles, Upload, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { VoiceRecorder } from "@/components/media/voice-recorder";
import { UploadProgress } from "@/components/media/upload-progress";
import { formatDuration, voiceExtension } from "@/lib/media/audio";
import { splitMediaPath, uploadAttachment } from "@/lib/media/upload";
import {
  getSttHealth,
  requestTranscription,
  waitForTranscription,
  TRANSCRIPTION_NOT_CONFIGURED,
} from "@/lib/data/transcriptions";
import { hapticsSuccess } from "@/lib/native/haptics";

type Phase = "grabando" | "subiendo" | "transcribiendo" | "listo" | "error";

export type DictateResult = {
  /** Texto transcrito (editable por el usuario antes de mandarlo). */
  text: string;
  /** Ruta del audio en Storage (para poder volver a transcribirlo). */
  objectPath: string | null;
  durationSeconds: number | null;
};

type DictateProps = {
  open: boolean;
  /** Espacio donde se sube el audio (ruta `{wsId}/…`). */
  wsId: string | null;
  /** Cierra la hoja (tambián cuando ya se mandó el texto). */
  onClose: () => void;
  /**
   * El texto entra al MISMO flujo que escribirlo a mano: el analizador
   * determinista primero, el modelo después, y vuelve la tarjeta de plan.
   */
  onSubmit: (result: DictateResult) => void;
};

/**
 * "Dictar a Loki": grabar → transcribir → editar → enviar.
 *
 * El audio NUNCA va al navegador de terceros desde el cliente: se sube a
 * Storage (buckets privados con RLS por espacio) y lo transcribe la Edge
 * `loki-worker` con permisos de servidor, solo cuando este diálogo lo pide.
 * Por eso el texto siempre está: es el punto de partida del plan.
 *
 * Web sin micrófono (http sin TLS, permiso denegado, navegador sin
 * MediaRecorder): la alternativa es subir un archivo de audio, con el mismo
 * camino de subida + transcripción.
 */
export function DictateSheet({
  open,
  wsId,
  onClose,
  onSubmit,
}: DictateProps): React.JSX.Element | null {
  const [phase, setPhase] = React.useState<Phase>("grabando");
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState(0);
  /** Duración en segundos del audio (la que se guarda con la transcripción). */
  const [durationSec, setDurationSec] = React.useState<number | null>(null);
  const [objectPath, setObjectPath] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<boolean | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const requestRef = React.useRef(0);

  // Estado del proveedor: sin él no se manda ningún audio (y se dice claro).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSttHealth().then((stt) => {
      if (!cancelled) setHealth(stt.configured);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Al reabrir, todo limpio (y se corta cualquier trabajo en vuelo).
  React.useEffect(() => {
    if (!open) return;
    requestRef.current += 1;
    setPhase("grabando");
    setText("");
    setError(null);
    setProgress(0);
    setDurationSec(null);
    setObjectPath(null);
  }, [open]);

  const transcribeAndFill = React.useCallback(
    async (durationSeconds: number | null, path: string) => {
      const token = requestRef.current + 1;
      requestRef.current = token;
      setObjectPath(path);
      setPhase("transcribiendo");
      setError(null);
      try {
        const created = await requestTranscription({
          workspaceId: wsId ?? "",
          bucket: "chat-media",
          objectPath: path,
          durationSeconds,
        });
        if (requestRef.current !== token) return;
        const done = await waitForTranscription(created.workspaceId, created.objectPath);
        if (requestRef.current !== token) return;
        setText(done.text);
        setPhase("listo");
        void hapticsSuccess();
      } catch (err: unknown) {
        if (requestRef.current !== token) return;
        setError(err instanceof Error ? err.message : "No se pudo transcribir.");
        setPhase("error");
      }
    },
    [wsId],
  );

  const uploadAndTranscribe = React.useCallback(
    async (file: File, durationSeconds: number | null) => {
      if (wsId === null || wsId.trim() === "") {
        setError("Elige un espacio para dictar.");
        setPhase("error");
        return;
      }
      if (health === false) {
        setError(TRANSCRIPTION_NOT_CONFIGURED);
        setPhase("error");
        return;
      }
      const token = requestRef.current + 1;
      requestRef.current = token;
      setPhase("subiendo");
      setProgress(0);
      setError(null);
      setDurationSec(durationSeconds);
      try {
        const uploaded = await uploadAttachment(wsId, file, {
          bucket: "chat-media",
          onProgress: setProgress,
        });
        if (requestRef.current !== token) return;
        const split = splitMediaPath(uploaded.path);
        if (split === null) {
          setError("No se pudo guardar el audio.");
          setPhase("error");
          return;
        }
        await transcribeAndFill(
          durationSeconds ?? (uploaded.duration !== undefined ? uploaded.duration : null),
          split.objectPath,
        );
      } catch (err: unknown) {
        if (requestRef.current !== token) return;
        setError(err instanceof Error ? err.message : "No se pudo subir el audio.");
        setPhase("error");
      }
    },
    [wsId, health, transcribeAndFill],
  );

  const handleRecorded = React.useCallback(
    (blob: Blob, ms: number) => {
      const ext = voiceExtension(blob.type);
      const file = new File([blob], `dictado.${ext}`, {
        type: blob.type !== "" ? blob.type : "audio/webm",
      });
      void uploadAndTranscribe(file, ms / 1000);
    },
    [uploadAndTranscribe],
  );

  const handleFile = React.useCallback(
    (files: File[]) => {
      const file = files[0];
      if (file === undefined) return;
      if (!file.type.toLowerCase().startsWith("audio/")) {
        setError("Elige un archivo de audio.");
        setPhase("error");
        return;
      }
      void uploadAndTranscribe(file, null);
    },
    [uploadAndTranscribe],
  );

  const submit = React.useCallback(() => {
    const clean = text.trim();
    if (clean === "") return;
    onSubmit({ text: clean, objectPath, durationSeconds: durationSec });
    onClose();
  }, [text, objectPath, durationSec, onSubmit, onClose]);

  if (!open) return null;

  const busy = phase === "subiendo" || phase === "transcribiendo";
  const canRecord =
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Dictar a Loki"
      className="mx-auto flex w-full max-w-[520px] flex-col gap-2"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-divider bg-card p-3">
        <Icon icon={Mic} size={20} className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-foreground">
          Dictar a Loki
        </p>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Cerrar dictado"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-50"
        >
          <Icon icon={X} size={20} />
        </button>
      </div>

      {health === false ? (
        <p
          role="status"
          className="rounded-2xl border border-divider bg-surface-soft px-3 py-2.5 text-body-sm leading-5 text-muted-foreground"
        >
          {TRANSCRIPTION_NOT_CONFIGURED}. Pide al administrador que configure el
          proveedor de voz a texto (STT_API_KEY en las Edge Functions).
        </p>
      ) : null}

      {phase === "grabando" ? (
        <div className="flex flex-col gap-2">
          {canRecord ? (
            <VoiceRecorder
              mode="toggle"
              onCancel={onClose}
              onSend={handleRecorded}
              onError={(reason) => {
                if (reason !== "permiso") return;
                setError(
                  "El navegador no dejó usar el micrófono. Actívalo en los ajustes del sitio o sube un archivo de audio.",
                );
              }}
            />
          ) : (
            <p className="rounded-2xl border border-divider bg-surface-soft px-3 py-2.5 text-body-sm leading-5 text-muted-foreground">
              Este navegador no permite grabar. Sube un archivo de audio para
              dictar.
            </p>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-divider bg-surface-soft text-body-sm font-semibold text-foreground outline-none interactive"
          >
            <Icon icon={Upload} size={20} />
            Subir archivo de audio
          </button>
          <p className="text-meta leading-4 text-muted-foreground">
            Toca para empezar y para parar. Si no te deja usar el micrófono,
            sube el audio: el resto es igual.
          </p>
        </div>
      ) : null}

      {phase === "subiendo" ? (
        <UploadProgress fileName="Tu dictado" progress={progress} />
      ) : null}

      {phase === "transcribiendo" ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-divider bg-surface-soft px-3 py-3"
        >
          <Icon icon={Loader2} size={20} className="shrink-0 animate-spin text-muted-foreground" />
          <p className="min-w-0 flex-1 text-body-sm text-foreground">
            Transcribiendo tu voz…
          </p>
        </div>
      ) : null}

      {phase === "listo" ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-divider bg-card p-3">
          <label className="flex flex-col gap-1">
            <span className="block text-meta leading-4 text-muted-foreground">
              Texto dictado (edítalo si algo sonó mal)
            </span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={4}
              maxLength={4000}
              aria-label="Texto dictado"
              className="min-h-24 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm leading-5 text-foreground outline-none"
            />
          </label>
          <p className="text-meta leading-4 text-muted-foreground">
            Loki lo convierte en tareas, recordatorios, ítems de lista o
            eventos: te mostrará un plan para confirmar antes de crear nada.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={text.trim() === ""}
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
            >
              <Icon icon={Sparkles} size={20} />
              Enviar a Loki
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("grabando");
                setText("");
                setObjectPath(null);
                setError(null);
              }}
              className="min-h-11 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
            >
              Repetir
            </button>
          </div>
        </div>
      ) : null}

      {phase === "error" ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-2xl border border-danger/40 bg-surface-soft px-3 py-3"
        >
          <p className="text-body-sm leading-5 text-danger">
            {error ?? "No se pudo transcribir."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setPhase("grabando");
                setText("");
                setError(null);
                setObjectPath(null);
              }}
              className="min-h-11 flex-1 rounded-full bg-surface-soft text-body-sm font-semibold text-foreground outline-none interactive"
            >
              Intentar de nuevo
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-full bg-surface-soft text-body-sm font-semibold text-foreground outline-none interactive"
            >
              Cerrar
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          handleFile(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {durationSec !== null && durationSec > 0 ? (
        <p className="text-meta leading-4 text-muted-foreground">
          <Icon icon={FileAudio} size={20} className="mr-1 inline align-[-4px]" />
          {formatDuration(durationSec)} · máximo 5 minutos
        </p>
      ) : null}
    </div>
  );
}
