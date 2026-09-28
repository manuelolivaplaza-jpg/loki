"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { fade } from "@/lib/motion";
import type { SectionMeta } from "@/components/shell/sections";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
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
            variants={fade}
            initial="hidden"
            animate="show"
            exit="exit"
            className="h-dvh w-[320px] overflow-y-auto border-l border-divider px-3 py-3"
          >
            <SectionLabel>{section.contextTitle}</SectionLabel>
            <Card>
              {section.contextItems.map((item, index) => (
                <React.Fragment key={item.title}>
                  {index > 0 ? <CardDivider /> : null}
                  <CardRow>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-meta text-muted-foreground">
                        {item.meta}
                      </span>
                    </span>
                  </CardRow>
                </React.Fragment>
              ))}
            </Card>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
