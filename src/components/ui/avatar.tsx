import { avatarTextColor } from "@/types/models";
import { cn } from "@/lib/utils";

export type AvatarSize = 32 | 36 | 40 | 44 | 52 | 64;

const FONT_SIZE: Record<AvatarSize, number> = {
  32: 15,
  36: 16,
  40: 17,
  44: 17,
  52: 20,
  64: 20,
};

type AvatarProps = {
  /** Inicial a mostrar (una letra). Se ignora si se pasa `emoji`. */
  initial?: string;
  /** Color de fondo (de la paleta de `models`). Sin color usa superficie neutra. */
  color?: string;
  /** Emoji en vez de inicial (fondo gris neutro). */
  emoji?: string;
  size?: AvatarSize;
  className?: string;
};

/**
 * Avatar del sistema: círculo con inicial + color de la paleta,
 * o emoji sobre superficie neutra.
 */
export function Avatar({
  initial = "L",
  color,
  emoji,
  size = 40,
  className,
}: AvatarProps): React.JSX.Element {
  if (emoji !== undefined && emoji !== "") {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-title",
          className,
        )}
      >
        {emoji}
      </span>
    );
  }
  const background = color ?? undefined;
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: FONT_SIZE[size],
        ...(background !== undefined
          ? {
              backgroundColor: background,
              color: avatarTextColor(background),
            }
          : undefined),
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        background === undefined && "bg-surface-soft text-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}
