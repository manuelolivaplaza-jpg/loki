"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

type MobileHeaderProps = {
  title: string;
};

export function MobileHeader({ title }: MobileHeaderProps): React.JSX.Element {
  return (
    <header className="sticky top-0 z-20 flex h-[53px] items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur md:hidden">
      <Link
        href="/chat"
        aria-label="Loki, ir a Chat"
        className="rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-foreground"
        >
          L
        </span>
      </Link>
      <h1 className="text-[16px] font-semibold text-foreground">{title}</h1>
      <ThemeToggle />
    </header>
  );
}
