"use client";

import * as React from "react";

/** ¿Corre dentro del WebView de Capacitor? (ahí el SW no aporta nada). */
function isCapacitorRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "capacitor:") return true;
  if (navigator.userAgent.includes("Capacitor")) return true;
  const flags = window as unknown as { Capacitor?: unknown };
  return flags.Capacitor !== undefined;
}

/**
 * Registra `/sw.js` solo en producción web (nunca en Capacitor ni en dev).
 * El SW cachea la app y da fallback offline a /inicio; la cola de mensajes
 * vive en `src/lib/offline/outbox.ts`.
 */
export function RegisterSw(): React.JSX.Element | null {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (isCapacitorRuntime()) return;
    if (!("serviceWorker" in navigator)) return;
    const register = (): void => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
