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
 * (con nombres, 220px). El estado vive en `useUiStore` y se alterna con el
 * botón de la cabecera o con la zona vacía del pie (ambos se ven como
 * botón al pasar el puntero). El perfil va abajo, con avatar + nombre.
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
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-divider bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
        expanded ? "w-[220px]" : "w-[68px]",
      )}
    >
      <div className="flex items-center gap-1 px-1 pb-1 pt-2">
        <div className="w-full min-w-0 flex-1">
          <WorkspaceSwitcher />
        </div>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          title={toggleLabel}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
        >
          <Icon icon={expanded ? ChevronsLeft : ChevronsRight} size={20} />
        </button>
      </div>

      <nav aria-label="Navegación principal" className="mt-2 flex-1 px-2">
        <ul
          className={cn(
            "flex flex-col gap-1",
            expanded ? "items-stretch" : "items-center",
          )}
        >
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
                    "group relative flex h-10 items-center rounded-full px-3 py-2 outline-none interactive",
                    expanded ? "justify-start gap-3" : "justify-center",
                    active
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon icon={item.icon} size={24} active={active} />
                    {active && !expanded ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-2 top-0 h-2 w-2 rounded-full bg-accent"
                      />
                    ) : null}
                  </span>
                  {expanded ? (
                    <span className="text-body-sm">{item.label}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className={cn("mt-1 flex", expanded ? "block" : "justify-center")}>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Buscar"
            title="Buscar (Ctrl+K)"
            className={cn(
              "flex h-11 items-center rounded-full text-foreground outline-none interactive",
              expanded ? "w-full justify-start gap-3 px-3" : "w-11 justify-center",
            )}
          >
            <Icon icon={Search} size={20} />
            {expanded ? (
              <span className="text-body-sm">Buscar</span>
            ) : null}
          </button>
        </div>
        <div className={cn("mt-3 flex", expanded ? "block" : "justify-center")}>
          <Popover open={newOpen} onOpenChange={setNewOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Nuevo"
                aria-haspopup="menu"
                aria-expanded={newOpen}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-full bg-foreground text-background shadow-float outline-none interactive-solid dark:bg-white dark:text-black",
                  expanded && "w-full gap-2 px-4",
                )}
              >
                <Icon icon={Plus} size={20} />
                {expanded ? (
                  <span className="text-body-sm font-semibold">Nuevo</span>
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

      {/* Zona vacía del pie: también extiende u oculta la barra. */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={toggleLabel}
        title={toggleLabel}
        className="mx-2 mb-1 flex h-9 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
      >
        <Icon icon={expanded ? ChevronsLeft : ChevronsRight} size={20} />
      </button>

      <div
        className={cn(
          "flex flex-col gap-1 border-t border-divider px-2 py-2",
          expanded ? "items-stretch" : "items-center",
        )}
      >
        <NotificationsMenu expanded={expanded} />
        <div
          className={cn(
            "flex items-center gap-3 px-2 pt-1",
            expanded ? "justify-start" : "justify-center",
          )}
        >
          <ProfileMenu size={36} />
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
