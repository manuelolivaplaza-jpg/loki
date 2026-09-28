import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tarjeta gris del sistema: superficie suave, radio lg, sin borde.
 * Las filas internas se separan con `CardDivider` (divisor fino con inset).
 */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn("rounded-lg bg-surface-soft", className)} {...props} />
  );
}

type CardRowProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Altura mínima de la fila. Por defecto 56px (h-14). */
  minHeight?: "12" | "14" | "15";
};

const MIN_HEIGHT_CLASS = {
  "12": "min-h-12",
  "14": "min-h-14",
  "15": "min-h-15",
} as const;

/** Fila dentro de una Card: padding horizontal 16px y vertical 12px. */
export function CardRow({
  minHeight = "14",
  className,
  ...props
}: CardRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        MIN_HEIGHT_CLASS[minHeight],
        className,
      )}
      {...props}
    />
  );
}

/** Divisor fino con inset para separar CardRows. */
export function CardDivider({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn("mx-4 h-px bg-divider", className)} />
  );
}
