"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { formatDuration } from "@/lib/media/audio";
import { cn } from "@/lib/utils";

const BARS = 32;
const SPEEDS = [1, 1.5, 2] as const;

/**
 * Reproductor de nota de voz / audio: onda de barras CSS (sin librerías),
 * play/pause, velocidades 1x/1.5x/2x y duración. Las barras se rellenan según
 * el avance (`currentTime`); mientras suena, laten con una animación leve.
 */
export function VoiceMessage({
  url,
  duration,
  dark = false,
}: {
  url: string;
  /** Duración en segundos (la guardada en el adjunto). */
  duration?: number;
  /** Dentro de una burbuja propia oscura: barras claras. */
  dark?: boolean;
}): React.JSX.Element {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [total, setTotal] = React.useState(duration ?? 0);
  const [speedIndex, setSpeedIndex] = React.useState(0);
  const speed = SPEEDS[speedIndex] ?? 1;

  // Alturas fijas por URL (pseudoaleatorias pero estables entre renders).
  const bars = React.useMemo(() => {
    let seed = 0;
    for (let i = 0; i < url.length; i += 1) seed = (seed * 31 + url.charCodeAt(i)) >>> 0;
    return Array.from({ length: BARS }, (_, i) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const wave = Math.sin((i / BARS) * Math.PI) * 0.5 + 0.5;
      return 0.25 + ((seed % 100) / 100) * 0.35 + wave * 0.4;
    });
  }, [url]);

  const toggle = React.useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) audio.pause();
    else void audio.play().catch(() => undefined);
  }, [playing]);

  const cycleSpeed = React.useCallback(() => {
    setSpeedIndex((index) => (index + 1) % SPEEDS.length);
  }, []);

  React.useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.playbackRate = speed;
  }, [speed]);

  const filled = total > 0 ? Math.min(1, current / total) : 0;
  const filledBars = Math.round(filled * BARS);

  return (
    <div className="flex min-w-0 items-center gap-2" role="group" aria-label="Nota de voz">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) {
            setTotal(event.currentTarget.duration);
          }
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pausar nota de voz" : "Reproducir nota de voz"}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full outline-none interactive-solid",
          dark ? "bg-white text-black" : "bg-foreground text-background",
        )}
      >
        <Icon icon={playing ? Pause : Play} size={20} />
      </button>
      <div className="min-w-0 flex-1">
        <div
          aria-hidden="true"
          className={cn("flex h-7 items-center gap-[2px]", playing && "animate-pulse")}
        >
          {bars.map((height, index) => (
            <span
              key={index}
              style={{ height: `${Math.round(height * 100)}%` }}
              className={cn(
                "w-full min-w-[2px] rounded-full",
                index < filledBars
                  ? dark
                    ? "bg-white"
                    : "bg-foreground"
                  : dark
                    ? "bg-white/30"
                    : "bg-muted-foreground/40",
              )}
            />
          ))}
        </div>
        <p
          className={cn(
            "mt-0.5 text-meta tabular-nums leading-4",
            dark ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {formatDuration(current)} / {formatDuration(total)}
        </p>
      </div>
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`Velocidad: ${speed}x. Toca para cambiar.`}
        className={cn(
          "flex h-8 w-11 shrink-0 items-center justify-center rounded-full text-meta font-bold outline-none interactive",
          dark ? "text-white active:bg-white/20" : "text-foreground active:bg-surface",
        )}
      >
        {speed}x
      </button>
    </div>
  );
}
