"use client";

import * as React from "react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { getLokiStatus, LOKI_NOT_CONFIGURED_TITLE } from "@/lib/ai/loki";
import {
  getSpaceLimits,
  getSpaceUsage,
  getUsageByMember,
  getUsageByType,
  saveSpaceLimits,
  type MemberUsage,
  type SpaceLimits,
  type SpaceUsageTotals,
  type UsageSlice,
} from "@/lib/data/ai-usage";
import { useMembers } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

const JOB_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  chat_summary: "Resúmenes",
  day_digest: "Resumen del día",
  redact_highlights: "Destacados",
  transcribe_audio: "Transcripciones",
  ocr_image: "OCR",
  dispatch_agent: "Agentes",
};

/** 1 unidad ≈ 250 caracteres de ida+vuelta con el modelo. */
function formatUnits(units: number): string {
  if (units >= 1000) return `${(units / 1000).toFixed(1)}k`;
  return `${units}`;
}

function UsageBar({ ratio }: { ratio: number }): React.JSX.Element {
  const safe = Math.max(0, Math.min(1, ratio));
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface"
    >
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${Math.round(safe * 100)}%` }}
      />
    </span>
  );
}

/**
 * Pantalla "Uso de IA" del espacio: día/mes, desglose por función y por
 * miembro (esto último solo admins), límite editable por admins y estado
 * del proveedor. Móvil apilado, escritorio en dos columnas, sin hover.
 */
export function AiUsageSection({
  wsId,
  uid,
  isAdmin,
}: {
  wsId: string;
  uid: string;
  isAdmin: boolean;
}): React.JSX.Element {
  const [totals, setTotals] = React.useState<SpaceUsageTotals | null>(null);
  const [byType, setByType] = React.useState<UsageSlice[]>([]);
  const [byMember, setByMember] = React.useState<MemberUsage[]>([]);
  const [limits, setLimits] = React.useState<SpaceLimits | null>(null);
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [dailyInput, setDailyInput] = React.useState("");
  const membersQuery = useMembers(isAdmin ? wsId : null);

  React.useEffect(() => {
    if (wsId === "") return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const [t, bt, lim, status] = await Promise.all([
          getSpaceUsage(wsId),
          isAdmin ? getUsageByType(wsId) : Promise.resolve([]),
          getSpaceLimits(wsId),
          getLokiStatus(),
        ]);
        if (cancelled) return;
        setTotals(t);
        setByType(bt);
        setLimits(lim);
        setDailyInput(lim.dailyUnits === null ? "" : String(lim.dailyUnits));
        setConfigured(status.configured);
        if (isAdmin) {
          const bm = await getUsageByMember(wsId);
          if (!cancelled) setByMember(bm);
        }
      } catch {
        if (!cancelled) setError("No se pudo cargar el uso de IA.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, isAdmin]);

  async function handleSaveLimit(): Promise<void> {
    const parsed = dailyInput.trim() === "" ? null : Number(dailyInput.trim());
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      setError("El límite debe ser un número mayor que 0 (o vacío para el default).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next: SpaceLimits = {
        dailyUnits: parsed === null ? null : Math.floor(parsed),
        monthlyUnits: limits?.monthlyUnits ?? null,
      };
      await saveSpaceLimits(wsId, uid, next);
      setLimits(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el límite.");
    } finally {
      setSaving(false);
    }
  }

  const memberName = (userId: string): string => {
    const found = (membersQuery.data ?? []).find((m) => m.uid === userId);
    const name = found?.displayName.trim() ?? "";
    return name === "" ? "Miembro" : name;
  };
  const maxType = byType[0]?.units ?? 1;
  const maxMember = byMember[0]?.units ?? 1;

  return (
    <section aria-label="Uso de IA">
      <SectionLabel>Uso de IA</SectionLabel>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Hoy · {totals === null ? "…" : `${formatUnits(totals.dayUnits)} uds`}
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                {totals === null ? "Cargando…" : `${totals.dayCalls} llamadas al modelo`}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
                configured === true
                  ? "bg-success/15 text-success"
                  : "bg-surface text-muted-foreground",
              )}
            >
              {configured === null
                ? "Comprobando…"
                : configured
                  ? "Disponible"
                  : LOKI_NOT_CONFIGURED_TITLE}
            </span>
          </CardRow>
          <CardDivider />
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Este mes · {totals === null ? "…" : `${formatUnits(totals.monthUnits)} uds`}
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                {totals === null ? "Cargando…" : `${totals.monthCalls} llamadas al modelo`}
              </span>
            </span>
          </CardRow>
          {isAdmin ? (
            <>
              <CardDivider />
              <CardRow>
                <span className="min-w-0 flex-1">
                  <span className="block text-body leading-6 text-foreground">
                    Límite diario del espacio
                  </span>
                  <span className="block text-body-sm leading-5 text-muted-foreground">
                    Vacío = default (familia 200, equipo 1000)
                  </span>
                </span>
              </CardRow>
              <div className="flex items-center gap-2 px-4 pb-3">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label="Límite diario en unidades"
                  value={dailyInput}
                  onChange={(event) => setDailyInput(event.target.value)}
                  placeholder="200"
                  className="h-11 min-w-0 flex-1 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveLimit()}
                  disabled={saving}
                  className="h-11 shrink-0 rounded-sm bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
                >
                  {saving ? "Guardando…" : "Guardar"}
                </button>
              </div>
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

        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Por función (mes)
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                {isAdmin ? "Qué consume más" : "Solo visible para admins"}
              </span>
            </span>
          </CardRow>
          {isAdmin ? (
            <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
              {byType.length === 0 ? (
                <p className="text-body-sm leading-5 text-muted-foreground">
                  Sin consumo este mes.
                </p>
              ) : (
                byType.map((slice) => (
                  <div key={slice.key} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body-sm text-foreground">
                        {JOB_TYPE_LABELS[slice.key] ?? slice.key}
                      </span>
                      <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
                        {formatUnits(slice.units)} uds · {slice.calls} llamadas
                      </span>
                    </div>
                    <UsageBar ratio={slice.units / maxType} />
                  </div>
                ))
              )}
              {byMember.length > 0 ? (
                <>
                  <p className="pt-2 text-body leading-6 text-foreground">Por miembro</p>
                  {byMember.map((member) => (
                    <div key={member.userId} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body-sm text-foreground">
                          {memberName(member.userId)}
                        </span>
                        <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
                          {formatUnits(member.units)} uds
                        </span>
                      </div>
                      <UsageBar ratio={member.units / maxMember} />
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    </section>
  );
}
