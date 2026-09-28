"use client";

import { Check } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type CheckboxProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
};

/**
 * Checkbox redondo del sistema: 24px, borde tokenizado sin marcar y
 * negro (foreground) al marcar, con el spring visual del resto de
 * controles. Expone role=checkbox con aria-checked.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
}: CheckboxProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60",
        checked
          ? "bg-foreground text-background dark:bg-white dark:text-black"
          : "border border-border-strong text-transparent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center transition-opacity",
          checked ? "opacity-100" : "opacity-0",
        )}
      >
        <Icon icon={Check} size={20} />
      </span>
    </button>
  );
}
