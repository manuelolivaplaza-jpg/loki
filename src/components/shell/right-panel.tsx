"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { SectionMeta } from "@/components/shell/sections";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

type RightPanelProps = {
  section: SectionMeta;
};

export function RightPanel({ section }: RightPanelProps): React.JSX.Element {
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);

  return (
    <div
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 self-start overflow-hidden transition-[width] duration-200 ease-out xl:block",
        rightPanelOpen ? "xl:w-[320px]" : "xl:w-0",
      )}
    >
      <AnimatePresence initial={false}>
        {rightPanelOpen ? (
          <motion.aside
            key="right-panel"
            aria-label={`Panel contextual de ${section.label}`}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.18 }}
            className="h-dvh w-[320px] overflow-y-auto border-l border-border px-3 py-3"
          >
            <div className="px-1 py-1">
              <h2 className="text-base font-semibold text-foreground">
                {section.contextTitle}
              </h2>
              <p className="text-meta text-muted-foreground">
                {section.label} · resumen
              </p>
              <ul className="mt-3 divide-y divide-border">
                {section.contextItems.map((item) => (
                  <li key={item.title} className="min-w-0 py-2 first:pt-0 last:pb-0">
                    <p className="truncate text-[15px] font-medium text-foreground">
                      {item.title}
                    </p>
                    <p className="text-meta text-muted-foreground">{item.meta}</p>
                  </li>
                ))}
              </ul>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
