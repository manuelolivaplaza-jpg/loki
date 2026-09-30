"use client";

/**
 * Presencia del espacio: "quién está en línea" + "última vez" + estado.
 *
 * El "en línea ahora mismo" va por el canal Realtime Presence
 * `presence:{wsId}` (efímero, con `track`). La tabla `user_presence`
 * guarda el latido (`last_seen`, refrescado cada 60 s con `upsert`) y el
 * estado personalizado (emoji + texto), para mostrar "Última vez hace…"
 * cuando alguien no está conectado.
 *
 * Al cerrar la pestaña se intenta marcar `online: false` (best effort);
 * si no llega, la marca caduca sola por `last_seen` (tope 120 s).
 */

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";

/** Latido de `last_seen` (60 s) y caducidad de la marca en línea (120 s). */
const HEARTBEAT_MS = 60_000;
const ONLINE_FRESH_MS = 120_000;

export type PresenceMemberState = {
  /** En línea (Presence en vivo o latido fresco). */
  online: boolean;
  /** ISO de `last_seen` (null si nunca hubo latido). */
  lastSeen: string | null;
  statusEmoji: string;
  statusText: string;
};

export type UsePresenceResult = {
  /** Uids en línea (Presence en vivo + latidos frescos). */
  onlineIds: Set<string>;
  /** Estado por uid (en línea, última vez y estado personalizado). */
  states: Map<string, PresenceMemberState>;
  /** Mi estado personalizado (para el editor). */
  myStatus: { emoji: string; text: string };
  /** Guarda mi estado (emoji + texto, tope 120). */
  setMyStatus: (emoji: string, text: string) => Promise<void>;
};

type PresenceRow = {
  user_id: string;
  online: boolean;
  last_seen: string | null;
  status_emoji: string;
  status_text: string;
};

function presenceTopic(wsId: string): string {
  return `presence:${wsId}`;
}

/** Uids con entrada en el canal (la forma exacta de `presenceState`). */
function presenceKeys(channel: RealtimeChannel): string[] {
  const raw: unknown = channel.presenceState();
  if (typeof raw !== "object" || raw === null) return [];
  return Object.keys(raw as Record<string, unknown>);
}

function isPresenceRow(value: unknown): value is PresenceRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["user_id"] === "string" &&
    typeof row["online"] === "boolean" &&
    (typeof row["last_seen"] === "string" || row["last_seen"] === null) &&
    typeof row["status_emoji"] === "string" &&
    typeof row["status_text"] === "string"
  );
}

function freshOnline(lastSeen: string | null, nowMs: number): boolean {
  if (lastSeen === null) return false;
  const ms = new Date(lastSeen).getTime();
  if (Number.isNaN(ms)) return false;
  return nowMs - ms < ONLINE_FRESH_MS;
}

/** Escribe mi fila (latido o despedida). Solo cada uno escribe la suya. */
async function writeRow(
  wsId: string,
  uid: string,
  online: boolean,
  emoji: string,
  text: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("user_presence")
    .upsert(
      {
        user_id: uid,
        workspace_id: wsId,
        online,
        last_seen: new Date().toISOString(),
        status_emoji: emoji,
        status_text: text,
      },
      { onConflict: "user_id" },
    );
  if (error !== null) {
    throw new Error("No se pudo guardar tu presencia.");
  }
}

export function usePresence(
  wsId: string | null,
  uid: string | null,
): UsePresenceResult {
  const [liveIds, setLiveIds] = React.useState<Set<string>>(new Set());
  const [rows, setRows] = React.useState<Map<string, PresenceRow>>(new Map());
  const [myStatus, setMyStatusState] = React.useState({ emoji: "", text: "" });
  const statusRef = React.useRef({ emoji: "", text: "" });
  const channelRef = React.useRef<RealtimeChannel | null>(null);

  // Carga inicial de la tabla (última vez + estados de todo el espacio).
  React.useEffect(() => {
    if (wsId === null || wsId === "" || uid === null || uid === "") return;
    let cancelled = false;
    void getSupabaseClient()
      .from("user_presence")
      .select("user_id, online, last_seen, status_emoji, status_text")
      .eq("workspace_id", wsId)
      .then(({ data, error }) => {
        if (cancelled || error !== null) return;
        const next = new Map<string, PresenceRow>();
        for (const entry of data ?? []) {
          if (!isPresenceRow(entry)) continue;
          next.set(entry.user_id, entry);
        }
        setRows(next);
        const mine = next.get(uid);
        if (mine !== undefined) {
          statusRef.current = {
            emoji: mine.status_emoji,
            text: mine.status_text,
          };
          setMyStatusState({ ...statusRef.current });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wsId, uid]);

  // Canal + latido. Sin escritura al desmontar (salir de una pantalla no
  // es salir de la app): el canal se retira y el latido caduca solo.
  React.useEffect(() => {
    if (wsId === null || wsId === "" || uid === null || uid === "") return;
    const activeWsId: string = wsId;
    const activeUid: string = uid;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(presenceTopic(activeWsId), {
      config: { presence: { key: activeUid } },
    });
    channelRef.current = channel;

    const beat = (): void => {
      const current = statusRef.current;
      void writeRow(
        activeWsId,
        activeUid,
        true,
        current.emoji,
        current.text,
      ).catch(() => {
        // Sin red el latido se pierde; el próximo intervalo reintenta.
      });
    };

    channel
      .on("presence", { event: "sync" }, () => {
        setLiveIds(new Set(presenceKeys(channel)));
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        const current = statusRef.current;
        void channel
          .track({
            online: true,
            status_emoji: current.emoji,
            status_text: current.text,
          })
          .catch(() => undefined);
        beat();
      });

    const timer = setInterval(beat, HEARTBEAT_MS);

    // Despedida al cerrar la pestaña (puede no llegar: el latido caduca).
    const handleUnload = (): void => {
      const current = statusRef.current;
      void writeRow(activeWsId, activeUid, false, current.emoji, current.text).catch(
        () => undefined,
      );
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      clearInterval(timer);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [wsId, uid]);

  const setMyStatus = React.useCallback(
    async (emoji: string, text: string): Promise<void> => {
      if (wsId === null || wsId === "" || uid === null || uid === "") {
        throw new Error("Falta el espacio o la sesión.");
      }
      const cleanEmoji = emoji.trim().slice(0, 8);
      const cleanText = text.trim().slice(0, 120);
      statusRef.current = { emoji: cleanEmoji, text: cleanText };
      setMyStatusState({ ...statusRef.current });
      const channel = channelRef.current;
      if (channel !== null) {
        await channel
          .track({
            online: true,
            status_emoji: cleanEmoji,
            status_text: cleanText,
          })
          .catch(() => undefined);
      }
      await writeRow(wsId, uid, true, cleanEmoji, cleanText);
    },
    [wsId, uid],
  );

  return React.useMemo(() => {
    const nowMs = Date.now();
    const states = new Map<string, PresenceMemberState>();
    for (const [userId, row] of rows) {
      const online = liveIds.has(userId) || freshOnline(row.last_seen, nowMs);
      states.set(userId, {
        online,
        lastSeen: row.last_seen,
        statusEmoji: row.status_emoji,
        statusText: row.status_text,
      });
    }
    // En vivo pero sin fila en la tabla (primer latido en camino).
    for (const userId of liveIds) {
      if (!states.has(userId)) {
        states.set(userId, {
          online: true,
          lastSeen: null,
          statusEmoji: "",
          statusText: "",
        });
      }
    }
    return {
      onlineIds: new Set(
        [...states.entries()]
          .filter(([, state]) => state.online)
          .map(([userId]) => userId),
      ),
      states,
      myStatus,
      setMyStatus,
    };
  }, [rows, liveIds, myStatus, setMyStatus]);
}
