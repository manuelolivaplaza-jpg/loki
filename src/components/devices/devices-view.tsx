"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  History,
  MonitorSmartphone,
  Plus,
  Settings2,
} from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { isDeviceOnline } from "@/types/devices";
import { useDevices, useRevokeDevice } from "@/hooks/use-devices";
import { PairDeviceSheet } from "@/components/devices/pair-device-sheet";
import { DeviceSettingsSheet } from "@/components/devices/device-settings-sheet";
import type { DeviceDoc } from "@/types/devices";
import { cn } from "@/lib/utils";

function platformLabel(device: DeviceDoc): string {
  const base =
    device.platform === "windows"
      ? "Windows"
      : device.platform === "linux"
        ? "Linux"
        : device.platform === "macos"
          ? "macOS"
          : "Otro";
  return device.appVersion === "" ? base : `${base} · v${device.appVersion}`;
}

function DeviceRow({
  device,
  onSettings,
  onHistory,
  onRevoke,
  revoking,
}: {
  device: DeviceDoc;
  onSettings: () => void;
  onHistory: () => void;
  onRevoke: () => void;
  revoking: boolean;
}): React.JSX.Element {
  const online = isDeviceOnline(device);
  const revoked = device.revokedAt !== null;
  return (
    <Card>
      <CardRow>
        <span
          aria-label={revoked ? "Revocado" : online ? "En línea" : "Sin conexión"}
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            revoked ? "bg-danger" : online ? "bg-success" : "bg-surface",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium leading-6 text-foreground">
            {device.name}
          </span>
          <span className="block text-body-sm leading-5 text-muted-foreground">
            {revoked
              ? "Revocado"
              : `${platformLabel(device)} · ${
                device.lastSeenAt === null
                  ? "sin contacto aún"
                  : `último contacto ${device.lastSeenAt.toDate().toLocaleString("es-CL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
              }`}
          </span>
        </span>
        {!revoked ? (
          <>
            <button
              type="button"
              aria-label={`Historial de ${device.name}`}
              onClick={onHistory}
              className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
            >
              <Icon icon={History} size={22} />
            </button>
            <button
              type="button"
              aria-label={`Permisos de ${device.name}`}
              onClick={onSettings}
              className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
            >
              <Icon icon={Settings2} size={22} />
            </button>
          </>
        ) : null}
      </CardRow>
      {!revoked ? (
        <>
          <CardDivider />
          <CardRow minHeight="12">
            <button
              type="button"
              onClick={onRevoke}
              disabled={revoking}
              className="text-body-sm font-medium text-danger outline-none interactive disabled:opacity-60"
            >
              {revoking ? "Revocando…" : "Revocar este PC"}
            </button>
          </CardRow>
        </>
      ) : null}
    </Card>
  );
}

/**
 * Mis dispositivos: lista con estado, versión y último contacto; vincular,
 * permisos, historial y revocación. En móvil todo táctil; en escritorio los
 * iconos también responden al click.
 */
export function DevicesView(): React.JSX.Element {
  const router = useRouter();
  const { devices, isPending, error, retry } = useDevices();
  const revoker = useRevokeDevice();
  const [pairOpen, setPairOpen] = React.useState(false);
  const [settingsId, setSettingsId] = React.useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = React.useState<string | null>(null);

  const settingsDevice = devices.find((d) => d.id === settingsId) ?? null;

  if (isPending) {
    return (
      <div className="flex flex-col gap-3" aria-label="Cargando PCs">
        {[0, 1].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-soft" />
        ))}
      </div>
    );
  }
  if (error !== null) {
    return (
      <EmptyState
        icon={MonitorSmartphone}
        title="No se pudieron cargar tus PCs"
        description={error.message}
        action={{ label: "Reintentar", onClick: retry }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Mis PCs">
        <SectionLabel>Mis PCs</SectionLabel>
        {devices.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="Sin PCs vinculados"
            description="Vincula tu PC para ordenarle cosas desde el chat: abrir apps, buscar archivos o tomar capturas."
            action={{ label: "Vincular un PC", onClick: () => setPairOpen(true) }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onSettings={() => setSettingsId(device.id)}
                onHistory={() => router.push(`/dispositivos/historial?pc=${device.id}`)}
                onRevoke={() => setConfirmRevokeId(device.id)}
                revoking={revoker.isPending}
              />
            ))}
          </div>
        )}
      </section>

      {devices.length > 0 ? (
        <button
          type="button"
          onClick={() => setPairOpen(true)}
          className="flex min-h-14 items-center gap-3 rounded-2xl border border-dashed border-border px-4 text-left outline-none interactive"
        >
          <Icon icon={Plus} size={22} className="shrink-0 text-primary" />
          <span className="text-body font-medium text-foreground">Vincular otro PC</span>
        </button>
      ) : null}

      <section aria-label="Historial general">
        <SectionLabel>Actividad</SectionLabel>
        <Card>
          <CardRow
            role="link"
            tabIndex={0}
            onClick={() => router.push("/dispositivos/historial")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                router.push("/dispositivos/historial");
              }
            }}
            className="cursor-pointer outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Historial y auditoría
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Qué se ordenó, cuándo y con qué resultado
              </span>
            </span>
            <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
          </CardRow>
        </Card>
      </section>

      {revoker.error !== null ? (
        <p role="alert" className="text-body-sm text-danger">
          {revoker.error.message}
        </p>
      ) : null}

      {confirmRevokeId !== null ? (
        <div
          role="alertdialog"
          aria-label="Revocar PC"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => setConfirmRevokeId(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-overlay"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-body font-semibold text-foreground">
              ¿Revocar este PC?
            </h2>
            <p className="mt-1 text-body-sm leading-5 text-muted-foreground">
              Su credencial deja de valer al instante y vuelve a la pantalla de
              vinculación. El historial se conserva.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmRevokeId(null)}
                className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  revoker.revoke(confirmRevokeId);
                  setConfirmRevokeId(null);
                }}
                className="min-h-11 flex-1 rounded-full bg-danger px-4 text-body-sm font-semibold text-white outline-none interactive"
              >
                Revocar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PairDeviceSheet open={pairOpen} onClose={() => setPairOpen(false)} />
      <DeviceSettingsSheet
        device={settingsDevice}
        open={settingsId !== null}
        onClose={() => setSettingsId(null)}
      />
    </div>
  );
}
