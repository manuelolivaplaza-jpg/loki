"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/components/shell/sections";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function Sidebar(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-dvh w-[68px] shrink-0 flex-col border-r border-border bg-background md:flex xl:w-[220px]">
      <div className="flex h-[53px] items-center justify-center xl:justify-start xl:px-4">
        <Link
          href="/chat"
          aria-label="Loki, ir a Chat"
          className="rounded-full p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-foreground"
          >
            L
          </span>
          <span className="sr-only xl:hidden">Loki</span>
        </Link>
        <Link
          href="/chat"
          className="hidden rounded-full px-2 py-1 text-xl font-semibold tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent xl:block"
        >
          Loki
        </Link>
      </div>

      <nav aria-label="Navegación principal" className="mt-2 flex-1 px-2 xl:px-3">
        <ul className="flex flex-col items-center gap-1 xl:items-stretch">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
            const Icon = item.icon;
            return (
              <li key={item.key} className="w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex h-10 items-center justify-center rounded-full px-3 py-2 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent xl:justify-start xl:gap-3",
                    active
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon
                      aria-hidden
                      className="h-6 w-6 shrink-0"
                      strokeWidth={active ? 2.5 : 1.75}
                      fill={active && item.key === "chat" ? "currentColor" : "none"}
                    />
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute -right-1.5 top-0 h-1.5 w-1.5 rounded-full bg-accent xl:hidden"
                      />
                    ) : null}
                  </span>
                  <span className="hidden text-[15px] xl:inline">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex flex-col items-center gap-3 px-2 py-3 xl:flex-row xl:justify-between xl:px-3">
        <ThemeToggle />
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-2 text-meta font-medium text-muted-foreground"
        >
          M
        </span>
      </div>
    </aside>
  );
}
