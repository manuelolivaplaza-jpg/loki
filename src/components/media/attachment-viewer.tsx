"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import type { MessageAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

const SWIPE_PX = 60;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type MediaItem = MessageAttachment & { kind: "image" | "video" };

/**
 * Visor a pantalla completa: deslizar (touch) para cambiar de adjunto, zoom
 * con pellizco o botones +/-, cerrar con X o Escape (lo gestiona el Dialog).
 */
export function AttachmentViewer({
  items,
  index: startIndex,
  onClose,
}: {
  items: MediaItem[];
  index: number;
  onClose: () => void;
}): React.JSX.Element {
  const [index, setIndex] = React.useState(startIndex);
  const [zoom, setZoom] = React.useState(1);
  const touchStart = React.useRef<{ x: number; y: number } | null>(null);
  const pinchStart = React.useRef<number | null>(null);
  const total = items.length;
  const current = items[Math.min(index, total - 1)] as MediaItem | undefined;

  const go = React.useCallback(
    (next: number) => {
      setIndex((next + total) % total);
      setZoom(1);
    },
    [total],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "ArrowRight") go(index + 1);
      if (event.key === "ArrowLeft") go(index - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, index]);

  const onTouchStart = (event: React.TouchEvent): void => {
    if (event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]] as const;
      if (a !== undefined && b !== undefined) {
        pinchStart.current = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      }
      return;
    }
    const touch = event.touches[0];
    if (touch !== undefined) touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const onTouchMove = (event: React.TouchEvent): void => {
    // Pellizco: ajusta el zoom con la distancia entre dedos.
    if (event.touches.length === 2 && pinchStart.current !== null) {
      const [a, b] = [event.touches[0], event.touches[1]] as const;
      if (a === undefined || b === undefined) return;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const start = pinchStart.current;
      if (start > 0) {
        setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * (distance / start))));
        pinchStart.current = distance;
      }
      return;
    }
  };

  const onTouchEnd = (event: React.TouchEvent): void => {
    pinchStart.current = null;
    const start = touchStart.current;
    touchStart.current = null;
    if (start === null) return;
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - start.x;
    // Con zoom no se cambia de foto al deslizar (el gesto es paneo).
    if (zoom !== 1 || total <= 1) return;
    if (dx <= -SWIPE_PX) go(index + 1);
    else if (dx >= SWIPE_PX) go(index - 1);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-label="Visor de adjuntos"
        className="fixed inset-0 z-[70] grid max-h-none w-full max-w-none translate-x-0 translate-y-0 place-items-center rounded-none border-0 bg-black/95 p-0 max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        style={{ left: 0, top: 0, transform: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <DialogTitle className="sr-only">Adjunto {index + 1} de {total}</DialogTitle>
        <div className="flex h-full max-h-dvh w-full flex-col">
          <div className="flex h-14 shrink-0 items-center gap-2 px-2 text-white">
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar visor"
              className="flex h-10 w-10 items-center justify-center rounded-full outline-none interactive active:bg-white/20"
            >
              <Icon icon={X} size={24} />
            </button>
            <p className="min-w-0 flex-1 truncate text-center text-body-sm tabular-nums">
              {index + 1} / {total}
            </p>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.5))}
              disabled={zoom <= MIN_ZOOM}
              aria-label="Reducir zoom"
              className="flex h-10 w-10 items-center justify-center rounded-full outline-none interactive active:bg-white/20 disabled:opacity-40"
            >
              <Icon icon={Minus} size={22} />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.5))}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Ampliar zoom"
              className="flex h-10 w-10 items-center justify-center rounded-full outline-none interactive active:bg-white/20 disabled:opacity-40"
            >
              <Icon icon={Plus} size={22} />
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto px-2 pb-4">
            {total > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => go(index - 1)}
                  aria-label="Adjunto anterior"
                  className="absolute left-2 z-10 hidden h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white outline-none interactive active:bg-white/20 sm:flex"
                >
                  <Icon icon={ChevronLeft} size={24} />
                </button>
                <button
                  type="button"
                  onClick={() => go(index + 1)}
                  aria-label="Adjunto siguiente"
                  className="absolute right-2 z-10 hidden h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white outline-none interactive active:bg-white/20 sm:flex"
                >
                  <Icon icon={ChevronRight} size={24} />
                </button>
              </>
            ) : null}
            {current === undefined ? null : current.kind === "video" ? (
              <video
                key={current.url}
                src={current.url}
                controls
                playsInline
                className="max-h-full max-w-full rounded-lg"
              />
            ) : (
              <img
                key={current.url}
                src={current.url}
                alt={current.name}
                style={{ transform: `scale(${zoom})` }}
                className={cn("max-h-full max-w-full rounded-lg object-contain transition-transform")}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
