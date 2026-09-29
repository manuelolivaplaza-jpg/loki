import type { LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Ajustes de layout (p. ej. Loki IA, que añade chips debajo). */
  className?: string;
};

/** Estado vacío del sistema: icono 24 en círculo gris + título + descripción. */
export function EmptyState({
  icon,
  title,
  description,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center",
        className,
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-soft">
        <Icon icon={icon} size={24} className="text-muted-foreground" />
      </span>
      <h2 className="mt-4 text-body font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xs text-body-sm leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
