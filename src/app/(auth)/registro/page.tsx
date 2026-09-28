"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithGoogle, signUpWithEmail } from "@/lib/auth/actions";
import { useSessionStore } from "@/stores/session-store";
import { Avatar } from "@/components/ui/avatar";
import {
  GoogleIcon,
  googleButtonClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
} from "@/components/auth/auth-ui";

function RegistroForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = useSessionStore((state) => state.status);
  const next = searchParams.get("next") ?? "/inicio";

  const [displayName, setDisplayName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [googlePending, setGooglePending] = React.useState(false);

  React.useEffect(() => {
    if (status === "authenticated") {
      router.replace(next);
    }
  }, [status, next, router]);

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    setPending(true);
    try {
      await signUpWithEmail(email, password, displayName);
      router.replace(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ocurrió un error.");
    } finally {
      setPending(false);
    }
  }

  async function handleGoogle(): Promise<void> {
    setError(null);
    setGooglePending(true);
    try {
      await signInWithGoogle();
      router.replace(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ocurrió un error.");
    } finally {
      setGooglePending(false);
    }
  }

  const loginHref =
    next === "/inicio" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <Avatar initial="L" size={64} />
          <p className="mt-4 text-body-sm font-semibold text-foreground">Loki</p>
          <h1 className="mt-2 text-display font-semibold leading-tight text-foreground">
            Crea tu cuenta
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
          <div>
            <label htmlFor="registro-nombre" className={labelClassName}>
              Nombre
            </label>
            <input
              id="registro-nombre"
              name="displayName"
              type="text"
              autoComplete="name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Tu nombre"
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="registro-email" className={labelClassName}>
              Correo
            </label>
            <input
              id="registro-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="tu@correo.com"
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="registro-password" className={labelClassName}>
              Contraseña
            </label>
            <input
              id="registro-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Mínimo 6 caracteres"
              className={inputClassName}
            />
          </div>

          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending || googlePending}
            className={primaryButtonClassName}
          >
            {pending ? "Creando cuenta..." : "Crear cuenta"}
          </button>
        </form>

        <div className="my-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-divider" />
          <span className="text-meta text-muted-foreground">o</span>
          <span className="h-px flex-1 bg-divider" />
        </div>

        <button
          type="button"
          aria-label="Continuar con Google"
          onClick={handleGoogle}
          disabled={pending || googlePending}
          className={googleButtonClassName}
        >
          <GoogleIcon />
          {googlePending ? "Conectando..." : "Continuar con Google"}
        </button>

        <p className="mt-6 text-center text-body-sm text-muted-foreground">
          ¿Ya tienes cuenta?{" "}
          <Link href={loginHref} className="text-mention [@media(hover:hover)]:underline">
            Inicia sesión
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function RegistroPage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-background">
          <Avatar initial="L" size={64} />
        </main>
      }
    >
      <RegistroForm />
    </React.Suspense>
  );
}
