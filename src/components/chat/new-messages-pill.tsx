"use client";

import { ArrowDown } from "lucide-react";
import { motion } from "framer-motion";
import { Icon } from "@/components/ui/icon";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

type NewMessagesPillProps = {
  visible: boolean;
  onClick: () => void;
};

/** Pastilla flotante "Nuevos mensajes" sobre la barra de escritura. */
export function NewMessagesPill({ visible, onClick }: NewMessagesPillProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={spring}
      className={cn(
        "flex items-center gap-2 rounded-full bg-background px-4 py-2 shadow-float outline-none interactive",
        "text-body-sm font-medium text-foreground",
        "dark:border dark:border-white/10 dark:bg-surface-soft",
      )}
      aria-label="Bajar a los nuevos mensajes"
    >
      Nuevos mensajes
      <Icon icon={ArrowDown} size={20} />
    </motion.button>
  );
}
