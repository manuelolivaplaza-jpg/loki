"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { spring } from "@/lib/motion";
import { QuickActionsMobileMenu } from "@/components/shell/quick-actions";
import {
  NAV_ITEMS,
  isFullscreenRoute,
  type SectionMeta,
} from "@/components/shell/sections";
import { isActiveHref, useAppPathname } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Barra inferior premium: pill flotante liquid glass de 60px, 5 slots
 * idénticos en grid, iconos 22px en foreground (55% inactivos, 100% activo
 * con pastilla foreground/6 animada con layoutId). El + central es solo el
 * icono Plus 26px, sin fondos ni acentos.
 */
function BottomTab({
  item,
  active,
}: {
  item: SectionMeta;
  active: boolean;
}): React.JSX.Element {
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className="relative flex h-10 w-12 items-center justify-center rounded-full text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {active ? (
        <motion.span
          layoutId="bottom-nav-active-pill"
          aria-hidden="true"
          transition={spring}
          className="absolute inset-0 rounded-full bg-foreground/6"
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn("relative z-10", active ? "opacity-100" : "opacity-55")}
      >
        <Icon icon={item.icon} size={22} />
      </span>
    </Link>
  );
}

export function BottomNav(): React.JSX.Element | null {
  const pathname = useAppPathname();
  const [actionsOpen, setActionsOpen] = React.useState(false);

  if (isFullscreenRoute(pathname)) return null;

  const left = NAV_ITEMS.slice(0, 2);
  const right = NAV_ITEMS.slice(2);

  function isActive(href: string): boolean {
    return isActiveHref(pathname, href);
  }

  return (
    <>
      <nav
        aria-label="Navegación principal"
        className="fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-40 md:hidden"
      >
        <ul className="glass-bar grid h-15 grid-cols-5 items-center px-3">
          {left.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-center"
            >
              <BottomTab item={item} active={isActive(item.href)} />
            </li>
          ))}
          <li className="flex items-center justify-center">
            <button
              type="button"
              aria-label="Acciones rapidas"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((value) => !value)}
              className="flex h-11 w-11 items-center justify-center rounded-full text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <motion.span
                animate={{ rotate: actionsOpen ? 45 : 0 }}
                transition={spring}
                className="flex items-center justify-center"
              >
                <Plus aria-hidden="true" size={26} strokeWidth={2} />
              </motion.span>
            </button>
          </li>
          {right.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-center"
            >
              <BottomTab item={item} active={isActive(item.href)} />
            </li>
          ))}
        </ul>
      </nav>
      <QuickActionsMobileMenu
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
      />
    </>
  );
}
