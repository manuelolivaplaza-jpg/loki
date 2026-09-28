"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSessionStore } from "@/stores/session-store";

type AuthGuardProps = {
  children: React.ReactNode;
};

function Splash(): React.JSX.Element {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold text-foreground"
      >
        L
      </span>
      <span className="sr-only">Cargando Loki…</span>
    </div>
  );
}

export function AuthGuard({ children }: AuthGuardProps): React.JSX.Element {
  const status = useSessionStore((state) => state.status);
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === "unauthenticated") {
      const next = pathname ?? "/chat";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [status, pathname, router]);

  if (status !== "authenticated") {
    return <Splash />;
  }

  return <>{children}</>;
}
