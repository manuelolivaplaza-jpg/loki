/**
 * Punto de presencia + envoltorio de avatar + "Última vez hace…".
 *
 * Verde (`success`) en línea, gris desconectado. El punto lleva anillo del
 * fondo para que se recorte sobre el avatar sin romper el layout.
 */

import { Avatar, type AvatarSize } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function PresenceDot({
  online,
  size = 12,
  className,
}: {
  online: boolean;
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      title={online ? "En línea" : "Desconectado"}
      aria-label={online ? "En línea" : "Desconectado"}
      style={{ width: size, height: size }}
      className={cn(
        "shrink-0 rounded-full ring-2 ring-background",
        online ? "bg-success" : "bg-muted-foreground/40",
        className,
      )}
    />
  );
}

/**
 * Avatar con el punto de presencia abajo a la derecha. Misma caja que
 * `Avatar` (envoltorio `inline-flex` relativo), así no mueve el layout.
 */
export function AvatarWithPresence({
  initial,
  color,
  size = 40,
  online,
  dotSize = 12,
  className,
}: {
  initial: string;
  color?: string;
  size?: AvatarSize;
  online: boolean;
  dotSize?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Avatar initial={initial} color={color} size={size} />
      <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5">
        <PresenceDot online={online} size={dotSize} />
      </span>
    </span>
  );
}

/**
 * "Última vez" en español relativo (`hace 5 min`, `hace 2 h`, `ayer`).
 * Devuelve null sin dato (quien llama oculta la línea).
 */
export function formatLastSeen(
  iso: string | null,
  nowMs: number = Date.now(),
): string | null {
  if (iso === null || iso === "") return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = Math.max(0, nowMs - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "ahora mismo";
  if (diff < hour) {
    const mins = Math.floor(diff / minute);
    return `hace ${mins} min`;
  }
  if (diff < day) {
    const hours = Math.floor(diff / hour);
    return `hace ${hours} h`;
  }
  if (diff < 2 * day) return "ayer";
  return new Date(ms).toLocaleDateString("es", {
    day: "numeric",
    month: "short",
  });
}
