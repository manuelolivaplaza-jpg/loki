"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { validInviteCode } from "@/lib/validators";
import { useAcceptInvite } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** Aceptar una invitación por código (?code=). Pide login si hace falta. */
function InviteForm({ code }: { code: string }): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const status = useSessionStore((state) => state.status);
  const setCurrentWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);
  const accept = useAcceptInvite();
  const [manualCode, setManualCode] = React.useState(code);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ name: string } | null>(null);

  React.useEffect(() => {
    setManualCode(code);
  }, [code]);

  if (status === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background">
        <Avatar initial="L" size={64} />
      </main>
    );
  }

  if (user === null) {
    const loginHref = `/login?next=${encodeURIComponent(`/invite?code=${encodeURIComponent(code)}`)}`;
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-[400px] text-center">
          <div className="flex justify-center">
            <Avatar initial="L" size={64} />
          </div>
          <h1 className="mt-6 text-display font-semibold leading-tight text-foreground">
            Te invitaron a Loki
          </h1>
          <p className="mt-2 text-body-sm text-muted-foreground">
            Inicia sesión para unirte al espacio.
          </p>
          <Link
            href={loginHref}
            className="mt-6 flex h-11 w-full items-center justify-center rounded-full bg-foreground px-6 text-body-sm font-semibold text-background outline-none interactive-solid dark:bg-white dark:text-black"
          >
            Iniciar sesión
          </Link>
        </div>
      </main>
    );
  }

  async function join(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    // Mismo formato que la Edge/DB (8 mayúsculas sin 0/O/1/I).
    const code = validInviteCode(manualCode);
    if (code === null) {
      setError("Ese código no es válido. Revisa las 8 letras y vuelve a intentarlo.");
      return;
    }
    try {
      const result = await accept.mutateAsync(code);
      setCurrentWorkspaceId(result.workspaceId);
      setDone({ name: result.workspaceName });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo unir al espacio.");
    }
  }

  if (done !== null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-[400px] text-center">
          <div className="flex justify-center">
            <Avatar initial="L" size={64} />
          </div>
          <h1 className="mt-6 text-display font-semibold leading-tight text-foreground">
            ¡Ya eres parte{done.name !== "" ? ` de ${done.name}` : ""}!
          </h1>
          <Button type="button" onClick={() => router.replace("/inicio")} className="mt-6 w-full">
            Ir a Inicio
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <Avatar initial="L" size={64} />
          <h1 className="mt-6 text-display font-semibold leading-tight text-foreground">
            Unirte al espacio
          </h1>
          <p className="mt-2 text-body-sm text-muted-foreground">
            Pega el código de invitación que te compartieron.
          </p>
        </div>
        <form onSubmit={(event) => void join(event)} className="mt-8 flex flex-col gap-4">
          <div>
            <label htmlFor="invite-code" className={labelClassName}>
              Código
            </label>
            <input
              id="invite-code"
              name="code"
              type="text"
              autoComplete="off"
              required
              minLength={8}
              maxLength={8}
              value={manualCode}
              onChange={(event) => setManualCode(event.target.value.toUpperCase())}
              placeholder="ABCDEFGH"
              className={`${inputClassName} text-center font-mono uppercase tracking-[0.3em]`}
            />
          </div>
          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={accept.isPending} className="w-full">
            {accept.isPending ? "Uniéndote…" : "Unirme"}
          </Button>
        </form>
      </div>
    </main>
  );
}

export default function InvitePage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-background">
          <Avatar initial="L" size={64} />
        </main>
      }
    >
      <InvitePageInner />
    </React.Suspense>
  );
}

function InvitePageInner(): React.JSX.Element {
  const searchParams = useSearchParams();
  return <InviteForm code={(searchParams.get("code") ?? "").toUpperCase()} />;
}
