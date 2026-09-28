import * as React from "react";
import { cn } from "@/lib/utils";

export type IconButtonVariant = "floating" | "ghost" | "accent" | "solid";

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  /** Botón circular blanco flotante con sombra (volver, cerrar, buscar, adjuntar). */
  floating:
    "bg-background text-foreground shadow-float interactive dark:bg-surface-soft",
  /** Botón circular transparente (panel, micrófono, toggle de tema). */
  ghost: "text-foreground interactive",
  /** Botón circular de acento para la acción central (+). */
  accent: "bg-accent text-accent-foreground shadow-float interactive-solid",
  /** Botón circular negro para enviar. */
  solid:
    "bg-foreground text-background interactive-solid dark:bg-white dark:text-black",
};

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: IconButtonVariant;
};

/**
 * Botón circular de 44px del sistema (h-11 w-11).
 * Pasa el icono como children (usa `Icon` con size 20 o 24).
 */
export function IconButton({
  variant = "floating",
  className,
  type = "button",
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none",
        VARIANT_CLASS[variant],
        className,
      )}
    />
  );
}
