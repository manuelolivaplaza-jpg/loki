"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { PanelRight } from "lucide-react";
import { BottomNav } from "@/components/shell/bottom-nav";
import { MobileHeader } from "@/components/shell/mobile-header";
import { RightPanel } from "@/components/shell/right-panel";
import { getSectionByPath } from "@/components/shell/sections";
import { Sidebar } from "@/components/shell/sidebar";
import { useUiStore } from "@/stores/ui-store";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  const pathname = usePathname();
  const section = getSectionByPath(pathname);
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <MobileHeader title={section.label} />

      <div className="mx-auto flex w-full max-w-[1265px] justify-center">
        <Sidebar />

        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full min-w-0 max-w-[680px] md:border-x md:border-border">
            <header className="sticky top-[53px] z-10 hidden h-[53px] items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur md:flex md:top-0">
              <h1 className="text-[20px] font-semibold text-foreground">
                {section.label}
              </h1>
              <button
                type="button"
                onClick={toggleRightPanel}
                aria-label={
                  rightPanelOpen
                    ? "Ocultar panel contextual"
                    : "Mostrar panel contextual"
                }
                aria-expanded={rightPanelOpen}
                className="hidden rounded-full p-2 text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent xl:inline-flex"
              >
                <PanelRight aria-hidden className="h-5 w-5" strokeWidth={2} />
              </button>
            </header>

            <main className="min-h-[calc(100dvh-106px)] pb-[calc(88px+env(safe-area-inset-bottom))] md:min-h-dvh md:pb-10">
              {children}
            </main>
          </div>

          <RightPanel section={section} />
        </div>
      </div>

      <BottomNav />
    </div>
  );
}
