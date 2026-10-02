"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toggle } from "@/components/ui/toggle";
import { CardDivider } from "@/components/ui/card";
import { DEVICE_CATALOG, deviceRiskOf } from "@/lib/devices/catalog";
import { useSaveDeviceSettings } from "@/hooks/use-devices";
import type { DeviceAction, DeviceDoc } from "@/types/devices";

const RISK_LABEL: Record<string, string> = {
  info: "Directa",
  normal: "Con tarjeta",
  sensible: "Apruebas en el teléfono",
};

/**
 * Permisos por dispositivo: qué acciones están habilitadas, qué carpetas se
 * pueden leer, si manda archivos al chat y si acepta terminal libre (siempre
 * con aprobación en el teléfono).
 */
export function DeviceSettingsSheet({
  device,
  open,
  onClose,
}: {
  device: DeviceDoc | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const saver = useSaveDeviceSettings();
  const [actions, setActions] = React.useState<DeviceAction[]>([]);
  const [dirsText, setDirsText] = React.useState("");
  const [canSend, setCanSend] = React.useState(true);
  const [arbitrary, setArbitrary] = React.useState(false);

  React.useEffect(() => {
    if (device !== null && open) {
      setActions(device.allowedActions);
      setDirsText(device.readableDirs.join("\n"));
      setCanSend(device.canSendFiles);
      setArbitrary(device.allowArbitrary);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.id, open ]);

  if (device === null) return null;

  // Captura para los manejadores: el estrechamiento de `device` no entra en closures.
  const currentDevice = device;

  function toggleAction(action: DeviceAction, next: boolean): void {
    setActions((prev) =>
      next ? [...prev, action] : prev.filter((entry) => entry !== action),
    );
  }

  function handleSave(): void {
    const dirs = dirsText
      .split("\n")
      .map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
      .filter((line) => line !== "" && !line.includes(".."))
      .slice(0, 20);
    saver.save(currentDevice.id, {
      allowedActions: actions,
      readableDirs: dirs,
      canSendFiles: canSend,
      // Sin terminal habilitada no hay arbitrarios aunque la acción esté marcada.
      allowArbitrary: arbitrary,
    });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={`Permisos de ${device.name}`}>
        <DialogTitle>Permisos de {device.name}</DialogTitle>
        <DialogDescription>
          Qué puede hacer tu PC cuando se lo ordenas desde el chat.
        </DialogDescription>
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto pt-2">
          {DEVICE_CATALOG.filter((entry) => entry.action !== "arbitrary_exec").map(
            (entry) => (
              <label
                key={entry.action}
                className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-2 outline-none interactive"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body leading-6 text-foreground">
                    {entry.label}
                  </span>
                  <span className="block text-body-sm leading-5 text-muted-foreground">
                    {RISK_LABEL[deviceRiskOf(entry.action)]}
                  </span>
                </span>
                <Toggle
                  checked={actions.includes(entry.action)}
                  onCheckedChange={(checked) => toggleAction(entry.action, checked)}
                  label={entry.label}
                />
              </label>
            ),
          )}
          <CardDivider className="my-1" />
          <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-2 outline-none interactive">
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Mandar archivos al chat
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Apruebas cada envío en el teléfono
              </span>
            </span>
            <Toggle checked={canSend} onCheckedChange={setCanSend} label="Mandar archivos al chat" />
          </label>
          <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-2 outline-none interactive">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-body leading-6 text-foreground">
                <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
                Terminal libre
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Comandos arbitrarios, siempre con tu aprobación
              </span>
            </span>
            <Toggle checked={arbitrary} onCheckedChange={setArbitrary} label="Terminal libre" />
          </label>
          <label className="flex flex-col gap-1 px-2 pt-2">
            <span className="text-meta leading-4 text-muted-foreground">
              Carpetas que se pueden leer (una por línea, p. ej. Documentos)
            </span>
            <textarea
              value={dirsText}
              onChange={(event) => setDirsText(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={"Documentos\nDescargas"}
              className="min-h-22 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm text-foreground outline-none"
            />
          </label>
        </div>
        {saver.error !== null ? (
          <p role="alert" className="text-body-sm text-danger">
            {saver.error.message}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={handleSave}
          disabled={saver.isPending}
          className="min-h-11 w-full"
        >
          {saver.isPending ? "Guardando…" : "Guardar permisos"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
