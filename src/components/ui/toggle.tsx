"use client";

import { motion } from "framer-motion";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type ToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
};

/** Geometría iOS del switch: track 51x31, thumb 27px con inset 2px. */
const THUMB_SIZE = 27;
const TRACK_INSET = 2;
const TRACK_WIDTH = 51;
/** Recorrido del thumb: 51 - 27 - 2*2 = 20px (queda 2px libres a la derecha). */
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - TRACK_INSET * 2;

/**
 * Switch tipo iOS del sistema en neutros (negro en claro, blanco en oscuro).
 * El thumb (27px) viaja 20px dentro del track 51x31 sin salirse en ningún
 * estado, animado con el spring común. Expone role=switch con aria-checked
 * y anillo de foco accent.
 */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
}: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-[31px] w-[51px] shrink-0 overflow-hidden rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60",
        checked ? "bg-foreground dark:bg-white" : "bg-divider",
      )}
    >
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ x: checked ? THUMB_TRAVEL : 0 }}
        transition={spring}
        className={cn(
          "absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-float",
          checked && "dark:bg-black",
        )}
      />
    </button>
  );
}
