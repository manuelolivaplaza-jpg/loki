"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const current = theme === "system" ? resolvedTheme : theme;
  const isDark = mounted ? current === "dark" : false;

  function toggle(): void {
    setTheme(isDark ? "light" : "dark");
  }

  return (
    <IconButton
      type="button"
      variant="ghost"
      onClick={toggle}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
    >
      {mounted && isDark ? (
        <Icon icon={Sun} size={20} />
      ) : (
        <Icon icon={Moon} size={20} />
      )}
    </IconButton>
  );
}
