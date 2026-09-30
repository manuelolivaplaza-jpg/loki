"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronsLeft, ChevronsRight, Plus, Search } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { ProfileMenu } from "@/components/shell/profile-menu";
import {
  QuickActionDialog,
  QuickActionsList,
  type QuickAction,
} from "@/components/shell/quick-actions";
import { NAV_ITEMS } from "@/components/shell/sections";
import { NotificationsMenu } from "@/components/notifications/notifications-menu";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { isActiveHref, useAppPathname } from "@/lib/navigation";
import { useProfileStore } from "@/stores/profile-store";
import { useSearchStore } from "@/stores/search-store";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

/**
 * Barra lateral de escritorio: contraída (solo iconos, 68px) o extendida
 * (con nombres, 220px). Sin animaciones: el cambio es instantáneo. El
 * botón circular sobre el borde y el borde mismo alternan el estado.
 * La columna de iconos queda siempre fija a la izquierda: al extender solo
 * aparecen los nombres, nada se mueve. El perfil va abajo, con avatar fijo
 * + nombre.
 */
export function Sidebar(): React.JSX.Element {
  const pathname = useAppPathname();
  const expanded = useUiStore((state) => state.sidebarExpanded);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const setSearchOpen = useSearchStore((state) => state.setOpen);
  const [newOpen, setNewOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<QuickAction | null>(null);

  const displayName =
    profile?.displayName.trim() !== "" &&
    profile?.displayName !== undefined &&
    profile.displayName !== null
      ? profile.displayName
      : (user?.displayName?.trim() !== "" ? user?.displayName : null) ??
        "Usuario";
  const toggleLabel = expanded ? "Ocultar barra lateral" : "Extender barra lateral";

  return (
    <aside
      className={cn(
        "relative sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-divider bg-background md:flex",
        expanded ? "w-[220px]" : "w-[68px]",
      )}
    >
      {/* Borde clicable + botón circular: alternan la barra, sin animación. */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={toggleLabel}
        title={toggleLabel}
        className="absolute -right-2 top-0 z-10 h-full w-4 cursor-ew-resize bg-transparent outline-none"
      >
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-divider bg-background text-muted-foreground shadow-float"
        >
          <Icon icon={expanded ? ChevronsLeft : ChevronsRight} size={20} />
        </span>
      </button>
      <div className="px-2 pb-1 pt-2">
        <WorkspaceSwitcher expanded={expanded} />
      </div>

      <nav aria-label="Navegación principal" className="flex min-h-0 flex-1 flex-col px-2">
        <ul className="flex flex-col items-stretch gap-1">
          {NAV_ITEMS.map((item) => {
            const active = isActiveHref(pathname, item.href);
            return (
              <li key={item.key} className="w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex h-10 items-center justify-start gap-3 rounded-full px-3 py-2 outline-none interactive",
                    active
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground",
                  )}
                >
                  <span className="relative flex shrink-0 items-center justify-center">
                    <Icon icon={item.icon} size={24} active={active} />
                    {active && !expanded ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-2 top-0 h-2 w-2 rounded-full bg-accent"
                      />
                    ) : null}
                  </span>
                  {expanded ? (
                    <span className="truncate text-body-sm">{item.label}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Buscar"
            title="Buscar (Ctrl+K)"
            className="flex h-11 w-full items-center justify-start gap-3 rounded-full px-3 text-foreground outline-none interactive"
          >
            <span className="flex shrink-0 items-center justify-center">
              <Icon icon={Search} size={20} />
            </span>
            {expanded ? (
              <span className="truncate text-body-sm">Buscar</span>
            ) : null}
          </button>
        </div>
        <div className="mt-3">
          <Popover open={newOpen} onOpenChange={setNewOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Nuevo"
                aria-haspopup="menu"
                aria-expanded={newOpen}
                className="flex h-11 w-full items-center justify-start gap-2 rounded-full bg-foreground px-3 text-background shadow-float outline-none interactive-solid dark:bg-white dark:text-black"
              >
                <span className="flex shrink-0 items-center justify-center">
                  <Icon icon={Plus} size={20} />
                </span>
                {expanded ? (
                  <span className="truncate text-body-sm font-semibold">Nuevo</span>
                ) : null}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              <QuickActionsList
                onSelect={(action) => {
                  setNewOpen(false);
                  setSelected(action);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

      </nav>

      <div className="flex flex-col items-stretch gap-1 border-t border-divider px-2 py-2">
        <NotificationsMenu expanded={expanded} />
        <div className="flex items-center justify-start gap-3 px-3 pt-1">
          <span className="flex shrink-0 items-center justify-center">
            <ProfileMenu size={36} />
          </span>
          {expanded ? (
            <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground">
              {displayName}
            </span>
          ) : null}
        </div>
      </div>
      <QuickActionDialog action={selected} onClose={() => setSelected(null)} />
    </aside>
  );
}
