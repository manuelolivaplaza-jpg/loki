"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ensureUserProfile } from "@/lib/data/users";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";

type AuthGuardProps = {
  children: React.ReactNode;
};

function Splash({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-4">
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold text-foreground"
      >
        L
      </span>
      <span className="sr-only">Cargando Loki…</span>
      {message !== undefined && message !== "" ? (
        <p role="alert" className="text-[13px] text-danger">
          {message}
        </p>
      ) : null}
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-border-strong px-4 py-2 text-[14px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

export function AuthGuard({ children }: AuthGuardProps): React.JSX.Element {
  const status = useSessionStore((state) => state.status);
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const profileStatus = useProfileStore((state) => state.profileStatus);
  const profileError = useProfileStore((state) => state.profileError);
  const setProfile = useProfileStore((state) => state.setProfile);
  const setProfileStatus = useProfileStore((state) => state.setProfileStatus);
  const setProfileError = useProfileStore((state) => state.setProfileError);
  const router = useRouter();
  const pathname = usePathname();
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (status === "unauthenticated") {
      const next = pathname ?? "/chat";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [status, pathname, router]);

  React.useEffect(() => {
    if (status !== "authenticated" || user === null) {
      return;
    }
    if (
      profile !== null &&
      profile.uid === user.uid &&
      profileStatus === "ready"
    ) {
      return;
    }
    let cancelled = false;
    setProfileStatus("loading");
    setProfileError(null);
    ensureUserProfile(user)
      .then((loaded) => {
        if (!cancelled) {
          setProfile(loaded);
          setProfileError(null);
          setProfileStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProfileError(
            error instanceof Error
              ? error.message
              : "No se pudo cargar tu perfil.",
          );
          setProfileStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    status,
    user,
    profile,
    profileStatus,
    attempt,
    setProfile,
    setProfileStatus,
    setProfileError,
  ]);

  React.useEffect(() => {
    if (status !== "authenticated") {
      return;
    }
    if (profileStatus !== "ready" || profile === null) {
      return;
    }
    const onOnboarding =
      pathname === "/onboarding" ||
      pathname?.startsWith("/onboarding/") === true;
    if (!profile.onboardingCompleted && !onOnboarding) {
      router.replace("/onboarding");
    } else if (profile.onboardingCompleted && onOnboarding) {
      router.replace("/chat");
    }
  }, [status, profileStatus, profile, pathname, router]);

  if (status !== "authenticated") {
    return <Splash />;
  }

  if (profileStatus !== "ready" || profile === null) {
    return (
      <Splash
        message={profileError ?? undefined}
        onRetry={
          profileStatus === "error"
            ? () => setAttempt((value) => value + 1)
            : undefined
        }
      />
    );
  }

  return <>{children}</>;
}
