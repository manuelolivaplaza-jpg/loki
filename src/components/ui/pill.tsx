import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Emoji o nodo de avatar a la izquierda. */
  leading: React.ReactNode;
  /** Texto principal de la pastilla. */
  text: string;
  /** Muestra chevron a la derecha. Por defecto true. */
  chevron?: boolean;
};

/**
 * Pastilla flotante del sistema (selector de espacio, cabecera de chat):
 * avatar/emoji + texto + chevron opcional, con sombra flotante.
 */
export function Pill({
  leading,
  text,
  chevron = true,
  className,
  type = "button",
  children,
  ...props
}: PillProps): React.JSX.Element {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "flex max-w-full items-center gap-2 rounded-full bg-background px-4 py-2 shadow-float outline-none interactive dark:border dark:border-white/10 dark:bg-surface-soft",
        className,
      )}
    >
      {leading}
      <span className="truncate text-body font-semibold text-foreground">
        {text}
      </span>
      {chevron ? (
        <Icon icon={ChevronDown} size={20} className="text-muted-foreground" />
      ) : null}
      {children}
    </button>
  );
}
