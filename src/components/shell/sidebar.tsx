"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
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
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { cn } from "@/lib/utils";

export function Sidebar(): React.JSX.Element {
  const pathname = usePathname();
  const [newOpen, setNewOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<QuickAction | null>(null);

  return (
    <aside className="sticky top-0 hidden h-dvh w-[68px] shrink-0 flex-col border-r border-divider bg-background md:flex xl:w-[220px]">
      <div className="flex flex-col items-center gap-2 px-1 pb-1 pt-2 xl:flex-row xl:items-center xl:gap-1 xl:px-2">
        <div className="w-full min-w-0 flex-1">
          <WorkspaceSwitcher />
        </div>
        <ProfileMenu size={36} />
      </div>

      <nav aria-label="Navegación principal" className="mt-2 flex-1 px-2 xl:px-3">
        <ul className="flex flex-col items-center gap-1 xl:items-stretch">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
            return (
              <li key={item.key} className="w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex h-10 items-center justify-center rounded-full px-3 py-2 outline-none interactive xl:justify-start xl:gap-3",
                    active
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon icon={item.icon} size={24} active={active} />
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-2 top-0 h-2 w-2 rounded-full bg-accent xl:hidden"
                      />
                    ) : null}
                  </span>
                  <span className="hidden text-body-sm xl:inline">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex justify-center xl:block">
          <Popover open={newOpen} onOpenChange={setNewOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Nuevo"
                aria-haspopup="menu"
                aria-expanded={newOpen}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground text-background shadow-float outline-none interactive-solid dark:bg-white dark:text-black xl:w-full xl:gap-2 xl:px-4"
              >
                <Icon icon={Plus} size={20} />
                <span className="hidden text-body-sm font-semibold xl:inline">
                  Nuevo
                </span>
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
      <QuickActionDialog action={selected} onClose={() => setSelected(null)} />
    </aside>
  );
}
