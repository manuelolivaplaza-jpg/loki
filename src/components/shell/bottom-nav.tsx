"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { NAV_ITEMS } from "@/components/shell/sections";
import { cn } from "@/lib/utils";

export function BottomNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-20 md:hidden"
    >
      <ul className="glass-bar flex h-[60px] items-center justify-around rounded-full px-2">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
          const Icon = item.icon;
          return (
            <li key={item.key} className="flex flex-1 items-center justify-center">
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
                    aria-hidden
                    transition={{ type: "spring", stiffness: 500, damping: 35 }}
                    className="glass-pill absolute inset-0 rounded-full"
                  />
                ) : null}
                <Icon
                  aria-hidden
                  className="relative z-10 h-6 w-6"
                  strokeWidth={active ? 2.5 : 1.75}
                  fill={active && item.key === "chat" ? "currentColor" : "none"}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
