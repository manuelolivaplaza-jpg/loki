"use client";

import * as React from "react";
import { History } from "lucide-react";
import { DEVICE_CATALOG, deviceSummary } from "@/lib/devices/catalog";
import { useDeviceAudit, useDeviceHistory, useDevices } from "@/hooks/use-devices";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type {
  DeviceAction,
  DeviceCommandDoc,
  DeviceCommandStatus,
} from "@/types/devices";

const STATUS_LABEL: Record<DeviceCommandStatus, string> = {
  pending_confirmation: "Por aprobar",
  queued: "En cola",
  delivered: "Recibido",
  running: "Ejecutando",
  done: "Listo",
  error: "Falló",
  rejected: "Rechazado",
  expired: "Venció",
};

const STATUS_CLASS: Record<DeviceCommandStatus, string> = {
  pending_confirmation: "bg-warning/15 text-warning-foreground",
  queued: "bg-surface text-muted-foreground",
  delivered: "bg-surface text-muted-foreground",
  running: "bg-primary/15 text-primary",
  done: "bg-success/15 text-success",
  error: "bg-danger/15 text-danger",
  rejected: "bg-surface text-muted-foreground",
  expired: "bg-surface text-muted-foreground",
};

const AUDIT_LABEL: Record<string, string> = {
  paired: "Vinculado",
  revoked: "Revocado",
  requested: "Pedido",
  confirmed: "Aprobado",
  rejected: "Rechazado",
  claimed: "Tomado por el PC",
  delivered: "Entregado",
  done: "Terminado",
  error: "Falló",
  expired: "Venció",
  settings: "Permisos cambiados",
};

function CommandRow({ command }: { command: DeviceCommandDoc }): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1 rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-body-sm font-semibold text-foreground">
          {deviceSummary(command.action, command.params)}
        </p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
            STATUS_CLASS[command.status],
          )}
        >
          {STATUS_LABEL[command.status]}
        </span>
      </div>
      {command.resultText !== "" && (command.status === "done" || command.status === "error") ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-body-sm leading-5 text-muted-foreground">
          {command.resultText}
        </p>
      ) : null}
      <p className="text-meta leading-4 text-muted-foreground">
        {command.createdAt.toDate().toLocaleString("es-CL", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {command.risk === "sensible" ? " · sensible" : ""}
      </p>
    </li>
  );
}

function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-meta leading-4 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-9 rounded-full px-3 text-body-sm font-medium outline-none interactive",
              value === option.value
                ? "bg-foreground text-background dark:bg-white dark:text-black"
                : "bg-surface-soft text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Historial por dispositivo con filtros (acción + estado) y auditoría.
 * En vivo por Realtime; sin PC seleccionado muestra el estado vacío útil.
 */
export function DeviceHistory({ deviceId }: { deviceId: string | null }): React.JSX.Element {
  const { devices } = useDevices();
  const [pc, setPc] = React.useState<string | null>(deviceId);
  const [action, setAction] = React.useState<DeviceAction | "all">("all");
  const [status, setStatus] = React.useState<DeviceCommandStatus | "all">("all");
  const [tab, setTab] = React.useState<"commands" | "audit">("commands");
  const history = useDeviceHistory(pc, { action, status });
  const audit = useDeviceAudit(tab === "audit" ? pc : null);

  React.useEffect(() => {
    setPc(deviceId);
  }, [deviceId]);

  // Sin PC elegido se usa el primero (la pantalla nunca queda vacía si hay PCs).
  React.useEffect(() => {
    if (deviceId === null && devices.length > 0) {
      setPc((current) => current ?? devices[0]?.id ?? null);
    }
  }, [deviceId, devices]);

  const resolvedPc = pc ?? devices[0]?.id ?? null;
  const deviceName = devices.find((d) => d.id === resolvedPc)?.name ?? "tu PC";

  if (devices.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Sin historial todavía"
        description="Vincula tu PC para ver aquí todo lo que le ordenes."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {devices.length > 1 ? (
        <label className="flex flex-col gap-1">
          <span className="text-meta leading-4 text-muted-foreground">PC</span>
          <select
            aria-label="PC"
            value={resolvedPc ?? ""}
            onChange={(event) => setPc(event.target.value)}
            className="h-11 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="flex gap-1.5" role="tablist" aria-label="Historial o auditoría">
        {(["commands", "audit"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "min-h-9 flex-1 rounded-full text-body-sm font-medium outline-none interactive",
              tab === key
                ? "bg-foreground text-background dark:bg-white dark:text-black"
                : "bg-surface-soft text-foreground",
            )}
          >
            {key === "commands" ? "Comandos" : "Auditoría"}
          </button>
        ))}
      </div>

      {tab === "commands" ? (
        <>
          <FilterChips
            label="Acción"
            value={action}
            onChange={setAction}
            options={[
              { value: "all", label: "Todas" },
              ...DEVICE_CATALOG.map((entry) => ({
                value: entry.action as DeviceAction | "all",
                label: entry.label,
              })),
            ]}
          />
          <FilterChips
            label="Estado"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "Todos" },
              { value: "done", label: "Listos" },
              { value: "pending_confirmation", label: "Por aprobar" },
              { value: "error", label: "Fallidos" },
              { value: "rejected", label: "Rechazados" },
            ]}
          />
          {history.isPending ? (
            <div className="flex flex-col gap-2" aria-label="Cargando historial">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-2xl bg-surface-soft" />
              ))}
            </div>
          ) : history.error !== null ? (
            <EmptyState
              icon={History}
              title="No se pudo cargar el historial"
              description={history.error.message}
              action={{ label: "Reintentar", onClick: history.retry }}
            />
          ) : history.commands.length === 0 ? (
            <EmptyState
              icon={History}
              title="Nada por aquí"
              description={`Ningún comando de ${deviceName} coincide con esos filtros.`}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {history.commands.map((command) => (
                <CommandRow key={command.id} command={command} />
              ))}
            </ul>
          )}
        </>
      ) : audit.isPending ? (
        <div className="flex flex-col gap-2" aria-label="Cargando auditoría">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-2xl bg-surface-soft" />
          ))}
        </div>
      ) : audit.entries.length === 0 ? (
        <EmptyState
          icon={History}
          title="Sin movimientos"
          description={`Todavía no hay auditoría de ${deviceName}.`}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {audit.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded-2xl border border-border bg-card p-3"
            >
              <Icon icon={History} size={18} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm font-medium leading-5 text-foreground">
                  {AUDIT_LABEL[entry.action] ?? entry.action}
                </span>
                {entry.detail !== "" ? (
                  <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                    {entry.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-meta leading-4 text-muted-foreground">
                {entry.createdAt.toDate().toLocaleString("es-CL", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
