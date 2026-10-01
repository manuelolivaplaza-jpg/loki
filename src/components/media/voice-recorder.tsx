"use client";

import * as React from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { formatDuration, pickVoiceMimeType } from "@/lib/media/audio";
import { hapticsLight, hapticsWarn } from "@/lib/native/haptics";
import { cn } from "@/lib/utils";

/** Umbral horizontal (px) para cancelar deslizando. */
const CANCEL_SLIDE_PX = 80;
/** Máximo de grabación: 5 minutos (se envía sola). */
const MAX_RECORD_MS = 5 * 60 * 1000;
const WAVE_BARS = 40;
/** Grabación demasiado corta para tener voz. */
const MIN_RECORD_MS = 1000;

type Phase = "grabando" | "sin-permiso";

/** Cómo se detiene la grabación. */
export type VoiceRecorderMode =
  /** Táctil: mantener para grabar, soltar para enviar, deslizar para cancelar. */
  | "hold"
  /** Escritorio/diálogo: click para empezar, click para parar. */
  | "toggle";

/** Por qué no se pudo grabar (para que el mensaje diga qué hacer). */
export type VoiceRecorderError = "permiso" | "no-soportado" | "otro";

/**
 * Grabadora de nota de voz.
 *
 * - `mode="hold"` (chat): MANTÉN para grabar, SUELTA para enviar, DESLIZA a la
 *   izquierda (>80px) para cancelar.
 * - `mode="toggle"` (diálogos y escritorio): un click empieza y el siguiente
 *   para; la papelera cancela.
 *
 * Onda en vivo con AnalyserNode, cronómetro, háptico al empezar y al terminar,
 * tope de 5 minutos (se envía sola) y corte automático si la app pasa a
 * segundo plano (no se pierde ni se manda un audio a medias).
 */
export function VoiceRecorder({
  onCancel,
  onSend,
  mode = "hold",
  onError,
}: {
  onCancel: () => void;
  /** Blob de audio + duración real en ms. */
  onSend: (blob: Blob, durationMs: number) => void;
  mode?: VoiceRecorderMode;
  /** Avisa por qué falló el micrófono (permiso, no soportado, otro). */
  onError?: (reason: VoiceRecorderError) => void;
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
  // En modo toggle el recording corre solo: `true` mientras hay sesión abierta.
  const [active, setActive] = React.useState(false);

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
    setActive(false);
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
      if (!send || recorder === null || recorder.state === "inactive" || durationMs < MIN_RECORD_MS) {
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
        else {
          void hapticsLight();
          onSend(blob, durationMs);
        }
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
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setPhase("sin-permiso");
      onError?.("no-soportado");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
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
      setActive(true);
      void hapticsLight();

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
    } catch (error: unknown) {
      stopTracks();
      setPhase("sin-permiso");
      onError?.(
        error instanceof DOMException && error.name === "NotAllowedError" ? "permiso" : "otro",
      );
    }
  }, [finish, onError, stopTracks]);

  // Limpieza al desmontar (cierra micrófono y timers).
  React.useEffect(() => () => stopTracks(), [stopTracks]);

  // Si la app pasa a segundo plano (o se bloquea la pantalla) se corta la
  // grabación: mejor una nota corta que un audio a medias que se pierde.
  React.useEffect(() => {
    if (!active) return;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        void hapticsWarn();
        finish(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, finish]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (mode !== "hold") return;
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
    if (mode !== "hold" || !holding) return;
    setWillCancel(startXRef.current - event.clientX >= CANCEL_SLIDE_PX);
  };

  const onPointerUp = (): void => {
    if (mode !== "hold" || !holding) return;
    setHolding(false);
    if (willCancel) {
      void hapticsWarn();
      finish(false);
      return;
    }
    if (recorderRef.current !== null) finish(true);
    else releaseRequestedRef.current = true;
  };

  const onToggle = (): void => {
    if (phase !== "grabando") return;
    if (active) {
      finish(true);
      return;
    }
    setLevels([]);
    setElapsedMs(0);
    void startRecording();
  };

  if (phase === "sin-permiso") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-2xl border border-divider bg-surface-soft px-3 py-2.5"
      >
        <p className="text-body-sm leading-5 text-foreground">
          No se pudo acceder al micrófono.
        </p>
        <p className="text-meta leading-4 text-muted-foreground">
          Actívalo en los ajustes del navegador (el candado junto a la
          dirección) o, en la app Android, en Ajustes → Apps → Loki →
          Permisos → Micrófono. Mientras tanto puedes subir un archivo de audio.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 self-start rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
        >
          Cerrar
        </button>
      </div>
    );
  }

  const toggleMode = mode === "toggle";
  const recording = toggleMode ? active : holding;

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
        onClick={() => {
          void hapticsWarn();
          finish(false);
        }}
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
      {toggleMode ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={active ? "Parar y enviar la nota de voz" : "Empezar a grabar"}
          aria-pressed={active}
          className={cn(
            "flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-full outline-none select-none interactive-solid",
            active ? "bg-danger text-white" : "bg-foreground text-background dark:bg-white dark:text-black",
          )}
        >
          <Icon icon={active ? Square : Mic} size={22} />
        </button>
      ) : (
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
      )}
    </div>
  );
}
