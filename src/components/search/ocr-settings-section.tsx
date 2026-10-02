"use client";

/**
 * Ajuste de OCR por espacio (Configuración): leer el texto de las imágenes
 * para que la búsqueda lo encuentre.
 *
 * Cuesta cuota de IA del espacio (visible en "Uso de IA"), así que nace
 * apagado y solo un admin lo cambia. Sin visión configurada en el servidor
 * se muestra "OCR sin configurar": las imágenes se encuentran por nombre.
 */

import * as React from "react";
import { ScanText } from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { Toggle } from "@/components/ui/toggle";
import {
  getOcrHealth,
  getSearchSettings,
  setOcrEnabled,
} from "@/lib/data/search";

export function OcrSettingsSection({
  wsId,
  uid,
  isAdmin,
}: {
  wsId: string | null;
  uid: string | null;
  isAdmin: boolean;
}): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(false);
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (wsId === null) return;
    void getSearchSettings(wsId).then((settings) => {
      if (!cancelled) setEnabled(settings.ocrEnabled);
    });
    void getOcrHealth().then((health) => {
      if (!cancelled) setConfigured(health.configured);
    });
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  async function handleChange(next: boolean): Promise<void> {
    if (wsId === null || uid === null) return;
    setSaving(true);
    setStatus(null);
    try {
      await setOcrEnabled(wsId, uid, next);
      setEnabled(next);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "No se pudo guardar el ajuste.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Texto en imágenes">
      <SectionLabel>Búsqueda en imágenes</SectionLabel>
      <Card>
        <CardRow>
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground dark:bg-surface-2"
          >
            <Icon icon={ScanText} size={22} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body leading-6 text-foreground">
              Leer el texto de las fotos
            </span>
            <span className="block text-body-sm leading-5 text-muted-foreground">
              {configured === false
                ? "OCR sin configurar: las imágenes se encuentran por nombre."
                : "Las fotos nuevas se leen solas y se encuentran por su texto."}
            </span>
          </span>
          <Toggle
            checked={enabled}
            onCheckedChange={(checked) => void handleChange(checked)}
            label="Leer el texto de las fotos"
            disabled={!isAdmin || saving || wsId === null}
          />
        </CardRow>
        <CardDivider />
        <CardRow minHeight="12">
          <span className="text-body-sm leading-5 text-muted-foreground">
            {isAdmin
              ? "Cada foto leída gasta cuota de IA del espacio. Nunca frena el envío."
              : "Solo un administrador del espacio puede cambiarlo."}
          </span>
        </CardRow>
        {status !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                {status}
              </span>
            </CardRow>
          </>
        ) : null}
      </Card>
    </section>
  );
}
