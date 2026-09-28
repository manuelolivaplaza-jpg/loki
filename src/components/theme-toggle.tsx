"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

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
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
    >
      {mounted && isDark ? <Sun /> : <Moon />}
    </Button>
  );
}
