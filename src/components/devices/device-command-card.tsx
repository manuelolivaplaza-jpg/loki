"use client";

import * as React from "react";
import {
  CheckCircle2,
  Clock,
  Loader2,
  MonitorSmartphone,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { deviceLabelOf, deviceSummary } from "@/lib/devices/catalog";
import { signDeviceResult } from "@/lib/data/devices";
import { useDeviceCommand } from "@/hooks/use-devices";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { DeviceCommandDoc } from "@/types/devices";

function StatusLine({ command }: { command: DeviceCommandDoc }): React.JSX.Element {
  switch (command.status) {
    case "pending_confirmation":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-warning">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          Esperando tu aprobación en el teléfono
        </span>
      );
    case "queued":
    case "delivered":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          {command.status === "queued" ? "En cola para tu PC" : "Tu PC lo recibió"}
        </span>
      );
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-primary">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          Ejecutándose en tu PC…
        </span>
      );
    case "done":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Listo
        </span>
      );
    case "rejected":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Rechazado por ti
        </span>
      );
    case "expired":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          Venció sin ejecutarse
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1.5 text-body-sm text-danger">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {command.error ?? "Falló en el PC"}
        </span>
      );
  }
}

function CommandResult({ command }: { command: DeviceCommandDoc }): React.JSX.Element | null {
  const [url, setUrl] = React.useState<string | null>(null);
  const isImage = command.resultPath !== null && command.resultMime.startsWith("image/");
  React.useEffect(() => {
    if (command.resultPath === null) return undefined;
    let cancelled = false;
    void signDeviceResult(command.resultPath).then((signed) => {
      if (!cancelled) setUrl(signed);
    });
    return () => {
      cancelled = true;
    };
  }, [command.resultPath]);
  if (command.resultPath !== null && url !== null && !isImage) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-body-sm font-medium text-mention outline-none interactive"
      >
        Ver archivo del PC
      </a>
    );
  }
  return (
    <>
      {isImage && url !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="Captura del PC"
          className="max-h-64 w-full rounded-xl border border-divider object-contain"
          loading="lazy"
        />
      ) : null}
      {command.resultText !== "" ? (
        <p className="whitespace-pre-wrap break-words text-body-sm leading-5 text-foreground">
          {command.resultText}
        </p>
      ) : null}
    </>
  );
}

/**
 * Tarjeta viva de un comando al PC (meta {kind:"device_command"}). Muestra el
 * estado en vivo por Realtime y el resultado (texto o captura/archivo desde
 * Storage). La expiración y los finales cierran el canal solos.
 */
export function DeviceCommandCard({ commandId }: { commandId: string }): React.JSX.Element {
  const { command, isPending, error, retry } = useDeviceCommand(commandId);
  if (isPending) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-3" aria-label="Cargando comando">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-body-sm text-muted-foreground">Cargando orden…</span>
      </div>
    );
  }
  if (command === null) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3">
        <p className="text-body-sm text-muted-foreground">
          {error === null ? "Esa orden ya no existe." : "No se pudo cargar la orden."}
        </p>
        {error !== null ? (
          <button
            type="button"
            onClick={retry}
            className="min-h-11 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
          >
            Reintentar
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Orden al PC: ${deviceLabelOf(command.action)}`}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Icon icon={MonitorSmartphone} size={20} className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate text-body-sm font-semibold text-foreground">
          {deviceSummary(command.action, command.params)}
        </p>
      </div>
      <StatusLine command={command} />
      {command.status === "done" || command.status === "error" ? (
        <CommandResult command={command} />
      ) : null}
      <p className={cn("text-meta leading-4 text-muted-foreground")}>
        {command.risk === "sensible" ? "Acción sensible · quedó registrada" : "Quedó registrada en el historial"}
      </p>
    </div>
  );
}
