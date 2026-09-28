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
      className="fixed inset-x-0 bottom-0 z-20 h-[calc(56px+env(safe-area-inset-bottom))] border-t border-border bg-background/75 backdrop-blur-md md:hidden"
    >
      <ul className="flex h-14 items-stretch justify-around px-2">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
          const Icon = item.icon;
          return (
            <li key={item.key} className="flex flex-1 items-stretch">
              <Link
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon
                  aria-hidden
                  className="h-6 w-6"
                  strokeWidth={active ? 2.5 : 1.75}
                  fill={active && item.key === "chat" ? "currentColor" : "none"}
                />
                <span className="text-[10px] font-medium leading-none">
                  {item.label}
                </span>
                {active ? (
                  <motion.span
                    layoutId="bottom-nav-active"
                    aria-hidden
                    transition={{ duration: 0.18 }}
                    className="absolute top-1 h-1 w-1 rounded-full bg-accent"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
