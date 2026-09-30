"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Deep links a /invite en Android (Capacitor).
 *
 * Escucha `appUrlOpen` del plugin App y, si la URL trae `?code=`, navega a
 * `/invite?code=...`. Cubre los tres formatos:
 *   - App Link https://loki.cl/invite?code=XXXXXXXX
 *   - Scheme propio loki://invite?code=XXXXXXXX
 *   - capacitor://localhost/invite?code=XXXXXXXX
 *
 * Nota App Links (sin secretos): para que https://loki.cl/invite abra la app
 * hay que publicar `https://loki.cl/.well-known/assetlinks.json` con el
 * `package_name` "cl.loki.app" y la huella SHA-256 del keystore, además del
 * `intent-filter` del AndroidManifest (ver android/app/src/main/...).
 */

function extractInviteCode(url: string): string | null {
  const match = url.match(/[?&]code=([A-Za-z0-9]{4,32})/);
  if (match === null) return null;
  const code = (match[1] ?? "").toUpperCase();
  return code === "" ? null : code;
}

export function DeepLinks(): React.JSX.Element | null {
  const router = useRouter();

  React.useEffect(() => {
    let cancelled = false;
    let remove: (() => void) | null = null;

    void import("@capacitor/app")
      .then(async ({ App }) => {
        if (cancelled) return;
        const handle = await App.addListener("appUrlOpen", (event) => {
          const code = extractInviteCode(event.url);
          if (code !== null) router.push(`/invite?code=${encodeURIComponent(code)}`);
        });
        remove = (): void => {
          void handle.remove();
        };
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      remove?.();
    };
  }, [router]);

  return null;
}
