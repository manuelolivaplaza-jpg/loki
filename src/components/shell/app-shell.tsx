"use client";

import * as React from "react";
import { PanelRight } from "lucide-react";
import { BottomNav } from "@/components/shell/bottom-nav";
import { MobileHeader } from "@/components/shell/mobile-header";
import { RightPanel } from "@/components/shell/right-panel";
import { getSectionByPath, isFullscreenRoute } from "@/components/shell/sections";
import { Sidebar } from "@/components/shell/sidebar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { WorkspaceBootstrap } from "@/components/workspaces/workspace-bootstrap";
import { normalizePathname, useAppPathname } from "@/lib/navigation";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: React.ReactNode;
};

function getHeaderTitle(pathname: string | null): string {
  const normalized = normalizePathname(pathname);
  if (normalized === "/perfil" || (normalized?.startsWith("/perfil/") ?? false)) {
    return "Perfil";
  }
  if (
    normalized === "/configuracion" ||
    (normalized?.startsWith("/configuracion/") ?? false)
  ) {
    return "Configuración";
  }
  return getSectionByPath(normalized).label;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  const pathname = useAppPathname();
  const section = getSectionByPath(pathname);
  const headerTitle = getHeaderTitle(pathname);
  const hideBottomNav = isFullscreenRoute(pathname);
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel);
  const { currentWorkspace, workspaces, isLoading: workspacesLoading } = useWorkspaces();
  const showWorkspaceSkeleton = workspacesLoading && workspaces.length === 0;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <WorkspaceBootstrap />
      <MobileHeader title={headerTitle} />

      <div className="flex w-full items-start">
        <Sidebar />

        <div className="flex min-w-0 flex-1 items-start">
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-10 hidden h-12 items-center justify-between bg-background/80 px-3 backdrop-blur md:flex lg:px-4">
              <div className="flex min-w-0 flex-col justify-center">
                <h1 className="truncate text-title font-semibold leading-tight text-foreground">
                  {headerTitle}
                </h1>
                {showWorkspaceSkeleton ? (
                  <span
                    aria-hidden="true"
                    className="mt-1 block h-4 w-32 animate-pulse rounded-full bg-surface-soft"
                  />
                ) : currentWorkspace !== null ? (
                  <p className="truncate text-meta leading-tight text-muted-foreground">
                    {currentWorkspace.emoji} {currentWorkspace.name}
                  </p>
                ) : null}
              </div>
              <IconButton
                variant="ghost"
                onClick={toggleRightPanel}
                aria-label={
                  rightPanelOpen
                    ? "Ocultar panel contextual"
                    : "Mostrar panel contextual"
                }
                aria-expanded={rightPanelOpen}
                className="hidden xl:inline-flex"
              >
                <Icon icon={PanelRight} size={20} />
              </IconButton>
            </header>

            <main
              className={cn(
                "min-h-[calc(100dvh-48px)] md:min-h-dvh md:pb-6",
                hideBottomNav
                  ? "pb-0"
                  : "pb-[calc(96px+env(safe-area-inset-bottom))]",
              )}
            >
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
