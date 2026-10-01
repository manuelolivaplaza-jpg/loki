"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { PanelRight } from "lucide-react";
import { BottomNav } from "@/components/shell/bottom-nav";
import { MobileHeader } from "@/components/shell/mobile-header";
import { NotificationsToast } from "@/components/notifications/notifications-toast";
import { RightPanel } from "@/components/shell/right-panel";
import { getSectionByPath, isFullscreenRoute } from "@/components/shell/sections";
import { Sidebar } from "@/components/shell/sidebar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { WorkspaceBootstrap } from "@/components/workspaces/workspace-bootstrap";
import { NativePushBootstrap } from "@/components/push/native-push-bootstrap";
import { ErrorBoundary } from "@/components/error-boundary";
import { normalizePathname, useAppPathname } from "@/lib/navigation";
import { useUiStore } from "@/stores/ui-store";
import { useSearchStore } from "@/stores/search-store";
import { useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: React.ReactNode;
};

/**
 * Paleta de búsqueda por code splitting: solo se descarga cuando se abre
 * (el atajo Cmd/Ctrl+K vive aquí, la paleta debajo con `ssr: false`).
 */
const SearchPalette = dynamic(
  () => import("@/components/search/search-palette").then((mod) => mod.SearchPalette),
  { ssr: false },
);

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
  const normalized = normalizePathname(pathname);
  const section = getSectionByPath(pathname);
  const headerTitle = getHeaderTitle(pathname);
  const hideBottomNav = isFullscreenRoute(pathname);
  const normalizedRoute = normalized ?? "";
  const isChatRoute =
    normalizedRoute === "/chat" || normalizedRoute.startsWith("/chat/");
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel);
  const setSearchOpen = useSearchStore((state) => state.setOpen);
  const {
    currentWorkspaceId,
  } = useWorkspaces();

  // Atajo global: Cmd/Ctrl+K abre la búsqueda desde cualquier pantalla.
  React.useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [setSearchOpen]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <WorkspaceBootstrap />
      <NativePushBootstrap />
      <MobileHeader title={headerTitle} />

      <div className="flex w-full items-start">
        <Sidebar />

        <div className="flex min-w-0 flex-1 items-start">
          <div className="flex min-w-0 flex-1 flex-col">
            <main
              className={cn(
                hideBottomNav
                  ? "min-h-[calc(100dvh-48px)] pb-0 md:min-h-dvh"
                  : "min-h-[calc(100dvh-48px)] pb-[calc(96px+env(safe-area-inset-bottom))] md:min-h-dvh",
                // Rutas de chat: columnas a alto fijo con su propio scroll
                // (una sola barra por columna, sin scroll de página).
                isChatRoute ? "md:pb-0" : "md:pb-6",
              )}
            >
              <ErrorBoundary section="el contenido">{children}</ErrorBoundary>
            </main>
          </div>

          <ErrorBoundary section="el panel contextual">
            <RightPanel section={section} />
          </ErrorBoundary>
        </div>
      </div>

      <BottomNav />
      <NotificationsToast />
      {/* Botón flotante del panel contextual (solo escritorio ancho). */}
      <div className="fixed right-4 top-4 z-40 hidden xl:block">
        <IconButton
          variant="floating"
          onClick={toggleRightPanel}
          aria-label={
            rightPanelOpen ? "Ocultar panel contextual" : "Mostrar panel contextual"
          }
          aria-expanded={rightPanelOpen}
          title={rightPanelOpen ? "Ocultar panel" : "Mostrar panel"}
        >
          <Icon icon={PanelRight} size={20} />
        </IconButton>
      </div>
      <ErrorBoundary section="la búsqueda">
        <SearchPalette wsId={currentWorkspaceId} />
      </ErrorBoundary>
    </div>
  );
}
