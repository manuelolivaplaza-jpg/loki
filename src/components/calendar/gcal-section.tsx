"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { useGcal } from "@/hooks/use-gcal";
import { cn } from "@/lib/utils";

function formatLastPull(iso: string | null): string {
  if (iso === null) return "Nunca sincronizado";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Nunca sincronizado";
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Sección "Google Calendar" de Configuración: estado de la conexión,
 * conectar (OAuth), desconectar con confirmación y sincronizar ahora.
 * Sin conexión no rompe nada: el calendario sigue funcionando solo Loki.
 */
export function GcalSection(): React.JSX.Element {
  const {
    status,
    isPending,
    connect,
    connecting,
    connectError,
    disconnect,
    disconnecting,
    pull,
    pulling,
    lastError,
  } = useGcal();
  const [confirming, setConfirming] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function handleSync(): Promise<void> {
    setNotice(null);
    const result = await pull();
    if (result === null) {
      if (lastError === null) setNotice("No hay conexión con Google.");
      return;
    }
    const parts: string[] = [];
    if (result.imported > 0) parts.push(`${result.imported} nuevo(s)`);
    if (result.updated > 0) parts.push(`${result.updated} actualizado(s)`);
    if (result.removed > 0) parts.push(`${result.removed} eliminado(s)`);
    if (parts.length === 0) {
      setNotice(`Ya está al día. Google devolvió ${result.fetched} evento(s) en 30 días.`);
    } else {
      setNotice(`Sincronizado: ${parts.join(", ")}.`);
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    await disconnect();
  }

  return (
    <section aria-label="Google Calendar">
      <SectionLabel>Google Calendar</SectionLabel>
      <Card>
        <CardRow>
          <span className="min-w-0 flex-1">
            <span className="block text-body leading-6 text-foreground">
              {isPending
                ? "Comprobando…"
                : status.connected
                  ? status.email !== ""
                    ? `Conectado como ${status.email}`
                    : "Conectado"
                  : "No conectado"}
            </span>
            <span className="block text-body-sm leading-5 text-muted-foreground">
              {status.connected
                ? `Última sincronización: ${formatLastPull(status.lastPullAt)}`
                : "Sincroniza tus eventos con Google en ambas direcciones"}
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
              status.connected
                ? "bg-success/15 text-success"
                : "bg-surface text-muted-foreground",
            )}
          >
            {isPending ? "Comprobando…" : status.connected ? "Conectado" : "Sin conectar"}
          </span>
        </CardRow>
        {connectError !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                {connectError}
              </span>
            </CardRow>
          </>
        ) : null}
        {lastError !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                {lastError}
              </span>
            </CardRow>
          </>
        ) : null}
        {notice !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="status" className="text-body-sm leading-5 text-muted-foreground">
                {notice}
              </span>
            </CardRow>
          </>
        ) : null}
        <CardDivider />
        <div className="flex flex-col gap-2 p-3">
          {status.connected ? (
            <>
              <Button
                type="button"
                disabled={pulling}
                onClick={() => void handleSync()}
                className="w-full"
              >
                {pulling ? "Sincronizando…" : "Sincronizar ahora"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={disconnecting}
                onClick={() => void handleDisconnect()}
                className="w-full"
              >
                {confirming ? "Toca de nuevo para desconectar" : "Desconectar"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={connecting || isPending}
              onClick={() => void connect()}
              className="w-full"
            >
              {connecting ? "Abriendo Google…" : "Conectar con Google"}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
