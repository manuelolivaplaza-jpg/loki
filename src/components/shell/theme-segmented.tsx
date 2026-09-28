"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

/** Selector de tema Claro/Oscuro como segmented control. */
export function ThemeSegmented(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const current = mounted && theme === "dark" ? "dark" : "light";

  return (
    <div
      role="radiogroup"
      aria-label="Tema"
      className="flex rounded-full bg-surface-soft p-1"
    >
      {(
        [
          { value: "light", label: "Claro" },
          { value: "dark", label: "Oscuro" },
        ] as const
      ).map((option) => {
        const selected = current === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            onClick={() => setTheme(option.value)}
            className={cn(
              "h-9 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              selected
                ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                : "text-muted-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
