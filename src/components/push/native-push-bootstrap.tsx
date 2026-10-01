"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { isNativePlatform, registerNativePush, setupNativeChrome } from "@/lib/push/native";
import { useSessionStore } from "@/stores/session-store";

/**
 * Push nativo (Android): al haber sesión registra el token FCM una vez y
 * deja los listeners (canal, tap → navegar). Sin sesión o sin ser nativo
 * no hace nada. Silencioso: el aviso en primer plano ya lo muestra el
 * toast de realtime; esto cubre app en fondo o cerrada.
 */
export function NativePushBootstrap(): React.JSX.Element | null {
  const router = useRouter();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const doneRef = React.useRef(false);

  // Marco del sistema (barra de estado): apenas monta, con o sin sesión.
  React.useEffect(() => {
    let cancelled = false;
    void isNativePlatform().then((native) => {
      if (!native || cancelled) return;
      void setupNativeChrome().catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (uid === null || doneRef.current) return;
    let cancelled = false;
    void isNativePlatform().then((native) => {
      if (!native || cancelled || doneRef.current) return;
      doneRef.current = true;
      void registerNativePush(
        (link) => {
          router.push(link);
        },
        {
          onAction: (link) => {
            router.push(link);
          },
        },
      ).catch(() => {
        // Sin permiso o sin red: se reintenta al reabrir la app.
        doneRef.current = false;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [uid, router]);

  return null;
}
