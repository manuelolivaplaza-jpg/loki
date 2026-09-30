"use client";

import * as React from "react";
import { Mic, Trash2 } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { formatDuration, pickVoiceMimeType } from "@/lib/media/audio";
import { cn } from "@/lib/utils";

/** Umbral horizontal (px) para cancelar deslizando. */
const CANCEL_SLIDE_PX = 80;
/** Máximo de grabación: 5 minutos (se envía sola). */
const MAX_RECORD_MS = 5 * 60 * 1000;
const WAVE_BARS = 40;

type Phase = "grabando" | "sin-permiso";

/**
 * Grabadora de nota de voz: MANTÉN el botón para grabar, SUELTA para enviar,
 * DESLIZA a la izquierda (>80px) para cancelar. Onda en vivo con AnalyserNode,
 * cronómetro y botón de papelera para cancelar.
 */
export function VoiceRecorder({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  /** Blob de audio + duración real en ms. */
  onSend: (blob: Blob, durationMs: number) => void;
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>("grabando");
  const [holding, setHolding] = React.useState(false);
  const [willCancel, setWillCancel] = React.useState(false);
  const [levels, setLevels] = React.useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = React.useRef(0);
  const startXRef = React.useRef(0);
  const releaseRequestedRef = React.useRef(false);
  const finishedRef = React.useRef(false);
  const mimeRef = React.useRef("");

  const stopTracks = React.useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  const finish = React.useCallback(
    (send: boolean) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      const durationMs = Date.now() - startTimeRef.current;
      stopTracks();
      // Sin grabación útil (cancelado, muy corta o nunca arrancó): se cierra.
      // Se intenta parar el MediaRecorder para soltar el micrófono del todo.
      if (!send || recorder === null || recorder.state === "inactive" || durationMs < 1000) {
        if (recorder !== null && recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Ya parado: no hay nada que soltar.
          }
        }
        onCancel();
        return;
      }
      // El último fragmento llega en `ondataavailable` ANTES de `onstop`: el
      // Blob solo se arma ahí, nunca justo después de `stop()`.
      recorder.onstop = (): void => {
        const type = mimeRef.current !== "" ? mimeRef.current : undefined;
        const blob = new Blob(chunksRef.current, type !== undefined ? { type } : undefined);
        chunksRef.current = [];
        if (blob.size === 0) onCancel();
        else onSend(blob, durationMs);
      };
      try {
        recorder.stop();
      } catch {
        onCancel();
      }
    },
    [onCancel, onSend, stopTracks],
  );

  const startRecording = React.useCallback(async () => {
    finishedRef.current = false;
    releaseRequestedRef.current = false;
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickVoiceMimeType();
      mimeRef.current = mime;
      const recorder =
        mime !== ""
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event: BlobEvent): void => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(250);
      startTimeRef.current = Date.now();

      // Onda en vivo: nivel RMS de la señal por AnalyserNode.
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx !== undefined) {
          const ctx = new Ctx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          const buffer = new Uint8Array(analyser.fftSize);
          let frames = 0;
          const tick = (): void => {
            const node = analyserRef.current;
            if (node === null) return;
            node.getByteTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i += 1) {
              const sample = (buffer[i] ?? 128) - 128;
              sum += sample * sample;
            }
            const level = Math.min(1, Math.sqrt(sum / buffer.length) / 40);
            frames += 1;
            if (frames % 3 === 0) {
              setLevels((prev) => [...prev.slice(-(WAVE_BARS - 1)), level]);
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch {
        // Sin onda, pero la grabación sigue.
      }

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setElapsedMs(elapsed);
        // Tope de 5 minutos: se envía sola.
        if (elapsed >= MAX_RECORD_MS) finish(true);
      }, 250);

      // Se soltó el botón antes de tener permiso: se envía al arrancar.
      if (releaseRequestedRef.current) finish(true);
    } catch {
      stopTracks();
      setPhase("sin-permiso");
    }
  }, [finish, stopTracks]);

  // Limpieza al desmontar (cierra micrófono y timers).
  React.useEffect(() => () => stopTracks(), [stopTracks]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (holding || phase !== "grabando") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startXRef.current = event.clientX;
    releaseRequestedRef.current = false;
    setWillCancel(false);
    setLevels([]);
    setElapsedMs(0);
    setHolding(true);
    void startRecording();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!holding) return;
    setWillCancel(startXRef.current - event.clientX >= CANCEL_SLIDE_PX);
  };

  const onPointerUp = (): void => {
    if (!holding) return;
    setHolding(false);
    if (willCancel) {
      finish(false);
      return;
    }
    if (recorderRef.current !== null) finish(true);
    else releaseRequestedRef.current = true;
  };

  if (phase === "sin-permiso") {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-2xl border border-divider bg-surface-soft px-3 py-2.5"
      >
        <p className="min-w-0 flex-1 text-body-sm text-muted-foreground">
          No se pudo acceder al micrófono. Revisa el permiso del navegador.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-full px-3 py-1.5 text-body-sm font-semibold text-accent outline-none interactive active:bg-surface"
        >
          Cerrar
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-2xl border px-3 py-2.5",
        willCancel ? "border-danger bg-surface-soft" : "border-divider bg-surface-soft",
      )}
      role="group"
      aria-label="Grabando nota de voz"
    >
      <button
        type="button"
        onClick={() => finish(false)}
        aria-label="Cancelar nota de voz"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
      >
        <Icon icon={Trash2} size={20} />
      </button>
      {willCancel ? (
        <p className="min-w-0 flex-1 text-center text-body-sm font-medium text-danger">
          Suelta para cancelar
        </p>
      ) : (
        <div aria-hidden="true" className="flex h-7 min-w-0 flex-1 items-center gap-[2px]">
          {Array.from({ length: WAVE_BARS }, (_, index) => {
            const level = levels[index] ?? 0;
            return (
              <span
                key={index}
                style={{ height: `${Math.round(12 + level * 88)}%` }}
                className={cn(
                  "w-full min-w-[2px] rounded-full",
                  index < levels.length ? "bg-danger" : "bg-muted-foreground/30",
                )}
              />
            );
          })}
        </div>
      )}
      <span className="shrink-0 text-body-sm font-medium tabular-nums text-foreground">
        {formatDuration(elapsedMs / 1000)}
      </span>
      <button
        type="button"
        aria-label={holding ? "Suelta para enviar la nota de voz" : "Mantén para grabar"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setHolding(false);
          finish(false);
        }}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-full outline-none select-none interactive-solid",
          holding && !willCancel ? "scale-110 bg-danger text-white" : "bg-foreground text-background dark:bg-white dark:text-black",
        )}
      >
        <Icon icon={Mic} size={22} />
      </button>
    </div>
  );
}
