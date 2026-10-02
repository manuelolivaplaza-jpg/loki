"use client";

/**
 * Configuración → Notificaciones → Resumen diario.
 *
 * Preferencias por usuario: activado sí/no, hora local (default 08:00), zona
 * horaria (default America/Santiago, detectada del dispositivo y editable),
 * días (todos o solo hábiles), qué espacios incluir y si se avisa con un
 * texto breve cuando no hay nada. La hora local se mantiene con el horario
 * de verano (la base calcula con `AT TIME ZONE` por usuario).
 */

import * as React from "react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { Toggle } from "@/components/ui/toggle";
import { deviceTimezone } from "@/lib/data/daily-digest";
import {
  useDailyDigestPrefs,
  useSaveDailyDigestPrefs,
} from "@/hooks/use-daily-digest";
import { useWorkspaces } from "@/stores/workspace-store";
import type { DailyDigestPrefs } from "@/types/organizer";
import { cn } from "@/lib/utils";

const TIMEZONES: readonly string[] = [
  "America/Santiago",
  "America/Lima",
  "America/Bogota",
  "America/Mexico_City",
  "America/Argentina/Buenos_Aires",
  "America/Sao_Paulo",
  "Europe/Madrid",
  "UTC",
];

export function DigestSettingsSection({ uid }: { uid: string | null }): React.JSX.Element {
  const prefsQuery = useDailyDigestPrefs(uid);
  const savePrefs = useSaveDailyDigestPrefs();
  const { workspaces } = useWorkspaces();
  const [error, setError] = React.useState<string | null>(null);

  const prefs: DailyDigestPrefs | null = prefsQuery.data ?? null;

  function handleChange(next: DailyDigestPrefs): void {
    setError(null);
    savePrefs.mutate(next, {
      onError: (err) => setError(err.message),
    });
  }

  if (uid === null) return <></>;
  if (prefsQuery.isPending && prefs === null) {
    return (
      <section aria-label="Resumen diario">
        <SectionLabel>Resumen diario</SectionLabel>
        <Card className="p-4">
          <span aria-hidden="true" className="block h-12 animate-pulse rounded-sm bg-surface-soft" />
        </Card>
      </section>
    );
  }
  if (prefs === null) return <></>;

  const allSpaces = prefs.workspaceIds.length === 0;

  function toggleSpace(wsId: string): void {
    const current = allSpaces ? workspaces.map((space) => space.wsId) : prefs.workspaceIds;
    const next = current.includes(wsId)
      ? current.filter((id) => id !== wsId)
      : [...current, wsId];
    // Todos marcados = todos los espacios (se guarda vacío).
    const normalized =
      next.length >= workspaces.length ? [] : next;
    handleChange({ ...prefs, workspaceIds: normalized });
  }

  return (
    <section aria-label="Resumen diario">
      <SectionLabel>Resumen diario</SectionLabel>
      <Card>
        <CardRow>
          <span className="min-w-0 flex-1">
            <span className="block text-body leading-6 text-foreground">
              Resumen de la mañana
            </span>
            <span className="block text-body-sm leading-5 text-muted-foreground">
              Una push con tu día: eventos, tareas, listas y encuestas
            </span>
          </span>
          <Toggle
            checked={prefs.enabled}
            onCheckedChange={(checked) => handleChange({ ...prefs, enabled: checked })}
            label="Resumen de la mañana"
          />
        </CardRow>
        {prefs.enabled ? (
          <>
            <CardDivider />
            <div className="flex items-center gap-3 px-4 py-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-meta text-muted-foreground">Hora (tu hora local)</span>
                <input
                  type="time"
                  aria-label="Hora del resumen"
                  value={prefs.digestTime}
                  onChange={(formEvent) =>
                    handleChange({ ...prefs, digestTime: formEvent.target.value })
                  }
                  className="h-11 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
                />
              </label>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-meta text-muted-foreground">Zona horaria</span>
                <select
                  aria-label="Zona horaria del resumen"
                  value={TIMEZONES.includes(prefs.timezone) ? prefs.timezone : "America/Santiago"}
                  onChange={(formEvent) =>
                    handleChange({ ...prefs, timezone: formEvent.target.value })
                  }
                  className="h-11 rounded-sm bg-surface-soft px-2 text-body-sm text-foreground outline-none"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3 px-4 pb-3">
              <button
                type="button"
                onClick={() => handleChange({ ...prefs, timezone: deviceTimezone() })}
                className="min-h-11 text-body-sm font-semibold text-mention outline-none interactive"
              >
                Usar la de este dispositivo
              </button>
            </div>
            <CardDivider />
            <CardRow>
              <span className="min-w-0 flex-1">
                <span className="block text-body leading-6 text-foreground">Días</span>
                <span className="block text-body-sm leading-5 text-muted-foreground">
                  Todos los días o solo de lunes a viernes
                </span>
              </span>
              <span role="group" aria-label="Días del resumen" className="flex shrink-0 gap-1 rounded-full bg-surface-soft p-1">
                {(
                  [
                    { value: "all", label: "Todos" },
                    { value: "weekdays", label: "Hábiles" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleChange({ ...prefs, days: option.value })}
                    aria-pressed={prefs.days === option.value}
                    className={cn(
                      "min-h-9 rounded-full px-3 text-body-sm outline-none interactive",
                      prefs.days === option.value
                        ? "bg-background font-semibold text-foreground shadow-float"
                        : "text-muted-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </span>
            </CardRow>
            {workspaces.length > 1 ? (
              <>
                <CardDivider />
                <CardRow>
                  <span className="min-w-0 flex-1">
                    <span className="block text-body leading-6 text-foreground">
                      Espacios incluidos
                    </span>
                    <span className="block text-body-sm leading-5 text-muted-foreground">
                      {allSpaces ? "Todos tus espacios en un solo resumen" : "Solo los marcados"}
                    </span>
                  </span>
                </CardRow>
                <ul className="px-4 pb-3">
                  {workspaces.map((space) => {
                    const checked = allSpaces || prefs.workspaceIds.includes(space.wsId);
                    return (
                      <li key={space.wsId} className="flex min-h-11 items-center gap-3">
                        <Toggle
                          checked={checked}
                          onCheckedChange={() => toggleSpace(space.wsId)}
                          label={space.name}
                        />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                          {space.emoji} {space.name}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            <CardDivider />
            <CardRow>
              <span className="min-w-0 flex-1">
                <span className="block text-body leading-6 text-foreground">
                  Avisar aunque no haya nada
                </span>
                <span className="block text-body-sm leading-5 text-muted-foreground">
                  Si está apagado y no tienes nada pendiente, no llega push
                </span>
              </span>
              <Toggle
                checked={prefs.sendWhenEmpty}
                onCheckedChange={(checked) => handleChange({ ...prefs, sendWhenEmpty: checked })}
                label="Avisar aunque no haya nada"
              />
            </CardRow>
          </>
        ) : null}
        {error !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                {error}
              </span>
            </CardRow>
          </>
        ) : null}
      </Card>
      <p className="px-2 pt-2 text-meta leading-4 text-muted-foreground">
        Llega a tu hora local (el horario de verano no la corre) y al tocarla
        abre Tu día. Respeta el horario de silencio.
      </p>
    </section>
  );
}
