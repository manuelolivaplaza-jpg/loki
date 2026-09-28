"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithEmail, signInWithGoogle } from "@/lib/auth/actions";
import { useSessionStore } from "@/stores/session-store";
import {
  GoogleIcon,
  googleButtonClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
} from "@/components/auth/auth-ui";

function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = useSessionStore((state) => state.status);
  const next = searchParams.get("next") ?? "/chat";

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
    setPending(true);
    try {
      await signInWithEmail(email, password);
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

  const registerHref =
    next === "/chat" ? "/registro" : `/registro?next=${encodeURIComponent(next)}`;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold text-foreground"
          >
            L
          </span>
          <p className="mt-4 text-[15px] font-semibold text-foreground">Loki</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight text-foreground">
            Inicia sesión en Loki
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
          <div>
            <label htmlFor="login-email" className={labelClassName}>
              Correo
            </label>
            <input
              id="login-email"
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
            <label htmlFor="login-password" className={labelClassName}>
              Contraseña
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Tu contraseña"
              className={inputClassName}
            />
          </div>

          {error !== null ? (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending || googlePending}
            className={primaryButtonClassName}
          >
            {pending ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-border-strong" />
          <span className="text-[13px] text-muted-foreground">o</span>
          <span className="h-px flex-1 bg-border-strong" />
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

        <p className="mt-6 text-center text-[14px] text-muted-foreground">
          ¿No tienes cuenta?{" "}
          <Link href={registerHref} className="text-mention hover:underline">
            Regístrate
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-background">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold text-foreground"
          >
            L
          </span>
        </main>
      }
    >
      <LoginForm />
    </React.Suspense>
  );
}
