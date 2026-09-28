"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { SectionMeta } from "@/components/shell/sections";
import { useUiStore } from "@/stores/ui-store";

type RightPanelProps = {
  section: SectionMeta;
};

export function RightPanel({ section }: RightPanelProps): React.JSX.Element {
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);

  return (
    <div className="hidden shrink-0 xl:block xl:w-[330px]">
      <AnimatePresence initial={false}>
        {rightPanelOpen ? (
          <motion.aside
            key="right-panel"
            aria-label={`Panel contextual de ${section.label}`}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.18 }}
            className="sticky top-0 h-dvh overflow-y-auto px-6 py-4"
          >
            <div className="rounded-2xl bg-surface p-4">
              <h2 className="text-base font-semibold text-foreground">
                {section.contextTitle}
              </h2>
              <p className="text-meta text-muted-foreground">
                {section.label} · resumen
              </p>
              <ul className="mt-3 space-y-3">
                {section.contextItems.map((item) => (
                  <li key={item.title} className="min-w-0">
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
