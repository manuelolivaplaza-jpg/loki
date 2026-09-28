import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type IconSize = 20 | 22 | 24;

type IconProps = {
  icon: LucideIcon;
  /** Tamaños fijos del sistema. Por defecto 22. */
  size?: IconSize;
  /**
   * Estado activo de la navegación: sube el grosor a 2.25.
   * Es el único lugar del sistema donde el grosor no es 1.75
   * y nunca se usa relleno (fill).
   */
  active?: boolean;
  className?: string;
};

/**
 * Único punto de render de iconos lucide. Fija strokeWidth 1.75
 * (2.25 solo en `active`) y tamaños 20/22/24 vía `size`.
 */
export function Icon({
  icon: Lucide,
  size = 22,
  active = false,
  className,
}: IconProps): React.JSX.Element {
  return (
    <Lucide
      aria-hidden="true"
      size={size}
      strokeWidth={active ? 2.25 : 1.75}
      className={cn("shrink-0", className)}
    />
  );
}
