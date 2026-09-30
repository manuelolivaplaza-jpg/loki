"use client";

import { X } from "lucide-react";
import { Icon } from "@/components/ui/icon";

/**
 * Barra de subida con % y botón de cancelar. La usa el composer mientras un
 * adjunto viaja a Storage (progreso real del `XMLHttpRequest`).
 */
export function UploadProgress({
  fileName,
  progress,
  onCancel,
}: {
  fileName: string;
  /** 0-100. */
  progress: number;
  onCancel: () => void;
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div
      role="status"
      aria-label={`Subiendo ${fileName}: ${clamped} %`}
      className="flex min-w-0 items-center gap-2 rounded-2xl border border-divider bg-surface-soft px-3 py-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium leading-5 text-foreground">
          {fileName}
        </span>
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clamped}
          className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${clamped}%` }}
          />
        </span>
      </span>
      <span className="shrink-0 text-meta font-medium tabular-nums text-muted-foreground">
        {clamped} %
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={`Cancelar subida de ${fileName}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
      >
        <Icon icon={X} size={20} />
      </button>
    </div>
  );
}
