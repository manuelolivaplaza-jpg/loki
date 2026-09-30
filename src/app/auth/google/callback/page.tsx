"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { exchangeGcal, pullGcal } from "@/lib/data/gcal";

/**
 * Vuelta de Google OAuth (?code= o ?error=). Intercambia el código por la
 * conexión guardada y vuelve a Configuración. Export estático: Suspense +
 * useSearchParams, como en /invite.
 */
function GoogleCallbackInner(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const code = searchParams.get("code") ?? "";
  const denied = searchParams.get("error") ?? "";
  const [state, setState] = React.useState<"working" | "done" | "error">(
    denied !== "" || code === "" ? "error" : "working",
  );
  const [message, setMessage] = React.useState<string>(
    denied !== ""
      ? "No diste permiso a Google. Puedes intentarlo de nuevo cuando quieras."
      : code === ""
        ? "Falta el código de Google. Vuelve a conectar desde Configuración."
        : "Conectando con Google…",
  );

  React.useEffect(() => {
    if (denied !== "" || code === "") return;
    let cancelled = false;
    void exchangeGcal(code).then(
      (email) => {
        if (cancelled) return;
        // Importación inmediata: los eventos de Google aparecen en el
        // calendario de la plataforma sin esperar a abrirlo.
        setMessage("Conectado. Importando tus eventos…");
        void pullGcal()
          .catch(() => undefined)
          .finally(() => {
            if (cancelled) return;
            void queryClient.invalidateQueries({ queryKey: ["events"] });
            setState("done");
            setMessage(
              email !== ""
                ? `Conectado como ${email}. Tus eventos ya están en el calendario.`
                : "Conectado. Tus eventos ya están en el calendario.",
            );
            window.setTimeout(() => {
              if (!cancelled) router.replace("/calendario");
            }, 1600);
          });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState("error");
        setMessage(
          err instanceof Error ? err.message : "No se pudo conectar con Google.",
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, denied, router, queryClient]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[400px] text-center">
        <div className="flex justify-center">
          <Avatar initial="L" size={64} />
        </div>
        <h1 className="mt-6 text-display font-semibold leading-tight text-foreground">
          {state === "done" ? "¡Calendario conectado!" : state === "error" ? "No se pudo conectar" : "Conectando…"}
        </h1>
        <p
          role={state === "error" ? "alert" : "status"}
          className="mt-2 text-body-sm text-muted-foreground"
        >
          {message}
        </p>
        {state === "error" ? (
          <Button
            type="button"
            onClick={() => router.replace("/configuracion")}
            className="mt-6 w-full"
          >
            Volver a Configuración
          </Button>
        ) : null}
      </div>
    </main>
  );
}

export default function GoogleCallbackPage(): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-background">
          <Avatar initial="L" size={64} />
        </main>
      }
    >
      <GoogleCallbackInner />
    </React.Suspense>
  );
}
