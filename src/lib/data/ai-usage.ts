"use client";

/**
 * Uso de IA por espacio: totales del día/mes, desglose por función y por
 * miembro, y límites editables por admins. Lee `ai_space_usage`,
 * `ai_space_usage_detail` y `ai_space_limits` (la RLS deja el desglose por
 * miembro solo a admins; la UI además lo oculta al resto).
 */

import { getSupabaseClient } from "@/lib/supabase/client";

export type SpaceUsageTotals = {
  dayUnits: number;
  dayCalls: number;
  monthUnits: number;
  monthCalls: number;
};

export type UsageSlice = {
  key: string;
  units: number;
  calls: number;
};

export type MemberUsage = UsageSlice & {
  userId: string;
};

export type SpaceLimits = {
  dailyUnits: number | null;
  monthlyUnits: number | null;
};

function monthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function sumRows(
  rows: readonly { units: number; calls: number }[],
): { units: number; calls: number } {
  let units = 0;
  let calls = 0;
  for (const row of rows) {
    units += row.units;
    calls += row.calls;
  }
  return { units, calls };
}

export async function getSpaceUsage(wsId: string): Promise<SpaceUsageTotals> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("ai_space_usage")
    .select("day, units, calls")
    .eq("workspace_id", wsId)
    .gte("day", monthStart());
  if (error !== null) {
    throw new Error("No se pudo cargar el uso de IA.");
  }
  const rows = (data ?? []) as { day: string; units: number; calls: number }[];
  const today = new Date().toISOString().slice(0, 10);
  const day = sumRows(rows.filter((row) => row.day === today));
  const month = sumRows(rows);
  return {
    dayUnits: day.units,
    dayCalls: day.calls,
    monthUnits: month.units,
    monthCalls: month.calls,
  };
}

export async function getUsageByType(wsId: string): Promise<UsageSlice[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("ai_space_usage_detail")
    .select("job_type, units, calls")
    .eq("workspace_id", wsId)
    .gte("day", monthStart());
  if (error !== null) {
    // Sin permiso (no admin) o sin filas: sin desglose.
    return [];
  }
  const byType = new Map<string, { units: number; calls: number }>();
  for (const row of (data ?? []) as { job_type: string; units: number; calls: number }[]) {
    const entry = byType.get(row.job_type) ?? { units: 0, calls: 0 };
    entry.units += row.units;
    entry.calls += row.calls;
    byType.set(row.job_type, entry);
  }
  return [...byType.entries()]
    .map(([key, value]) => ({ key, units: value.units, calls: value.calls }))
    .sort((a, b) => b.units - a.units);
}

export async function getUsageByMember(wsId: string): Promise<MemberUsage[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("ai_space_usage_detail")
    .select("user_id, units, calls")
    .eq("workspace_id", wsId)
    .gte("day", monthStart())
    .not("user_id", "is", null);
  if (error !== null) {
    return [];
  }
  const byUser = new Map<string, { units: number; calls: number }>();
  for (const row of (data ?? []) as { user_id: string; units: number; calls: number }[]) {
    const entry = byUser.get(row.user_id) ?? { units: 0, calls: 0 };
    entry.units += row.units;
    entry.calls += row.calls;
    byUser.set(row.user_id, entry);
  }
  return [...byUser.entries()]
    .map(([userId, value]) => ({ key: userId, userId, units: value.units, calls: value.calls }))
    .sort((a, b) => b.units - a.units);
}

export async function getSpaceLimits(wsId: string): Promise<SpaceLimits> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("ai_space_limits")
    .select("daily_units, monthly_units")
    .eq("workspace_id", wsId)
    .maybeSingle();
  if (error !== null || data === null) {
    return { dailyUnits: null, monthlyUnits: null };
  }
  const row = data as { daily_units: number | null; monthly_units: number | null };
  return { dailyUnits: row.daily_units, monthlyUnits: row.monthly_units };
}

export async function saveSpaceLimits(
  wsId: string,
  uid: string,
  limits: SpaceLimits,
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from("ai_space_limits").upsert(
    {
      workspace_id: wsId,
      daily_units: limits.dailyUnits,
      monthly_units: limits.monthlyUnits,
      updated_by: uid,
    },
    { onConflict: "workspace_id" },
  );
  if (error !== null) {
    throw new Error("No se pudo guardar el límite. Solo los admins pueden cambiarlo.");
  }
}
