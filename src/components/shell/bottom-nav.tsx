"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { spring } from "@/lib/motion";
import { QuickActionsMobileMenu } from "@/components/shell/quick-actions";
import {
  NAV_ITEMS,
  isFullscreenRoute,
  type SectionMeta,
} from "@/components/shell/sections";
import { cn } from "@/lib/utils";

// En móvil Ideas sale de la barra (vive en el menú + y en la sidebar desktop).
const MOBILE_TABS: readonly SectionMeta[] = NAV_ITEMS.filter(
  (item) => item.key !== "ideas",
);

function MobileTab({
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
      className={cn(
        "relative flex h-11 w-16 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {active ? (
        <motion.span
          layoutId="bottom-nav-active-pill"
          aria-hidden="true"
          transition={spring}
          className="glass-pill absolute inset-0 rounded-full"
        />
      ) : null}
      <span className="relative z-10">
        <Icon icon={item.icon} size={24} active={active} />
      </span>
    </Link>
  );
}

export function BottomNav(): React.JSX.Element | null {
  const pathname = usePathname();
  const [actionsOpen, setActionsOpen] = React.useState(false);

  if (isFullscreenRoute(pathname)) return null;

  const left = MOBILE_TABS.slice(0, 2);
  const right = MOBILE_TABS.slice(2);

  function isActive(href: string): boolean {
    return pathname === href || pathname?.startsWith(`${href}/`) === true;
  }

  return (
    <>
      <nav
        aria-label="Navegación principal"
        className="fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-40 md:hidden"
      >
        <ul className="glass-bar flex h-15 items-center justify-around px-2">
          {left.map((item) => (
            <li key={item.key} className="flex flex-1 items-center justify-center">
              <MobileTab item={item} active={isActive(item.href)} />
            </li>
          ))}
          <li className="flex items-center justify-center px-1">
            <IconButton
              variant="accent"
              aria-label="Acciones rapidas"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((value) => !value)}
              className="-translate-y-2"
            >
              <motion.span
                animate={{ rotate: actionsOpen ? 45 : 0 }}
                transition={spring}
                className="flex items-center justify-center"
              >
                <Icon icon={Plus} size={24} />
              </motion.span>
            </IconButton>
          </li>
          {right.map((item) => (
            <li key={item.key} className="flex flex-1 items-center justify-center">
              <MobileTab item={item} active={isActive(item.href)} />
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
