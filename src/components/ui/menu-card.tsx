import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Tarjeta flotante del sistema para menús: redondeada xl con sombra
 * flotante, sin borde. Úsala como contenedor de `MenuItem`s; para
 * popovers de Radix aplica las mismas clases al PopoverContent
 * (ver `menuCardClass`).
 */
export const menuCardClass =
  "rounded-xl border-0 bg-background p-2 shadow-float dark:bg-surface-soft";

export function MenuCard({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn(menuCardClass, className)} {...props} />;
}

type MenuItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  /** Variante destructiva (texto rojo). */
  danger?: boolean;
  /** Descripción secundaria (subtítulo muted). Activa la variante de 56px. */
  description?: string;
};

/**
 * Item de menú del sistema: 48px, Icon 22 + texto text-body.
 * Con `description`: variante de 56px mínimo, padding 16px/8px,
 * Icon 22 centrado, título text-body + subtítulo text-meta muted.
 */
export function MenuItem({
  icon,
  danger = false,
  description,
  className,
  type = "button",
  children,
  ...props
}: MenuItemProps): React.JSX.Element {
  if (description !== undefined) {
    return (
      <button
        type={type}
        {...props}
        className={cn(
          "flex min-h-14 w-full items-center gap-4 rounded-sm px-4 py-2 text-left outline-none interactive active:bg-surface-soft",
          danger ? "font-medium text-danger" : "text-foreground",
          className,
        )}
      >
        <Icon icon={icon} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body leading-6">
            {children}
          </span>
          <span className="mt-0.5 block truncate text-meta leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
      </button>
    );
  }
  return (
    <button
      type={type}
      {...props}
      className={cn(
        "flex h-12 w-full items-center gap-3 rounded-sm px-3 text-left text-body outline-none interactive active:bg-surface-soft",
        danger ? "font-medium text-danger" : "text-foreground",
        className,
      )}
    >
      <Icon icon={icon} size={22} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
