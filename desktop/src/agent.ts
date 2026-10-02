/**
 * Agente del compañero: UNA sola conexión saliente (WebSocket de Realtime)
 * suscrita a sus comandos. Sin consultas periódicas a la API, sin LLM, con
 * consumo mínimo en reposo.
 *
 * Por eventos, como manda la arquitectura:
 * - insert/update en `device_commands` → Realtime despierta al agente →
 *   `device_claim_command` → ejecuta → `device_report_result` → vuelve a
 *   dormir. `pg_cron` solo barre vencidos (SQL barato, sin LLM).
 * - Latido (`device_heartbeat`) al conectar y con cada comando: sin polling.
 * - El token de corta duración se renueva antes de vencer; si se cae la red o
 *   el PC vuelve de suspensión, reconecta con backoff y recoge los pendientes
 *   no vencidos. Si la credencial se revoca, lo respeta al instante.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { DESKTOP_VERSION, loadLocalConfig, loadRecent, pushRecent, saveLocalConfig } from "./config.js";
import { clearCredential, loadCredential } from "./secure-store.js";
import { logLocal } from "./logger.js";
import { deviceSummary, isDeviceAction, validateDeviceParams } from "./catalog.js";
import { notifyCommandStart, notifyRevoked } from "./notify.js";
import {
  claimCommand,
  createDeviceClient,
  fetchDeviceFicha,
  fetchPendingCommands,
  heartbeat,
  isRevokedError,
  platformName,
  reportResult,
  signInDevice,
  uploadResultFile,
  type ClaimTicket,
  type DeviceClient,
  type DeviceFicha,
  type PendingCommand,
} from "./supabase-device.js";
import { effectivePermissions } from "./tray-menu.js";
import type { ExecuteContext, ExecuteOutcome } from "./executors.js";
import { dispatchAction } from "./executors.js";

export type AgentState = "conectado" | "desconectado" | "ejecutando" | "pausado";

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
/** Rechazo interno para salir limpio con Ctrl+C / cierre del shell. */
const SHUTDOWN_MESSAGE = "Apagado solicitado.";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function backoffDelay(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 6));
  return exp + Math.floor(Math.random() * 1000);
}

export interface AgentEvents {
  onState?: (state: AgentState) => void;
}

export async function runAgent(events: AgentEvents = {}): Promise<never> {
  const setState = (s: AgentState): void => {
    try {
      events.onState?.(s);
    } catch {
      // El observador nunca rompe al agente.
    }
  };
  let attempt = 0;
  for (;;) {
    try {
      await runOnce(setState);
      attempt = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido.";
      if (message === SHUTDOWN_MESSAGE) {
        logLocal("apagado solicitado; saliendo limpio.");
        process.exit(0);
      }
      if (/revocad|desvincul/i.test(message)) {
        setState("desconectado");
        logLocal(`revocado: ${message}`);
        notifyRevoked();
        clearCredential();
        saveLocalConfig({ deviceId: null });
        console.error("Este PC fue desvinculado desde Loki. Vuelve a vincularlo (loki-desktop link).");
        process.exit(3);
      }
      attempt += 1;
      setState("desconectado");
      logLocal(`desconectado (${message}). Reintento en ${Math.round(backoffDelay(attempt) / 1000)} s.`);
      await sleep(backoffDelay(attempt));
    }
  }
}

async function runOnce(setState: (s: AgentState) => void): Promise<void> {
  const cfg = loadLocalConfig();
  const cred = await loadCredential();
  if (cred === null || cfg.deviceId === null) {
    console.error("Sin vincular. Pega tu código con: loki-desktop link --code XXXXXX");
    process.exit(2);
  }
  if (cfg.anonKey === "") {
    throw new Error("Falta la clave pública (anon). Usa link --anon o LOKI_SUPABASE_ANON_KEY.");
  }
  const client = createDeviceClient(cred.supabaseUrl, cfg.anonKey);
  await signInDevice(client, cred.email, cred.secret);
  scheduleTokenRefresh(client);

  let ficha = await fetchDeviceFicha(client, cred.deviceId);
  if (ficha === null) throw new Error("No se pudo leer la ficha del PC. Revisa la conexión.");
  if (ficha.revokedAt !== null) throw new Error("PC revocado. Vuelve a vincularlo.");
  if (ficha.ownerId === "") throw new Error("La ficha del PC vino incompleta.");

  await heartbeat(client, cred.deviceId, DESKTOP_VERSION, platformName()).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    if (isRevokedError(msg)) throw new Error("PC revocado. Vuelve a vincularlo.");
  });
  logLocal(`conectado como ${cred.deviceId} (dueño ${ficha.ownerId.slice(0, 8)}…)`);

  const queue: PendingCommand[] = [];
  let processing = false;
  let closed = false;
  /** Falla el `runOnce` completo (p. ej. revocación a mitad de un comando). */
  let failOuter: (e: Error) => void = () => undefined;

  const contextFor = (live: DeviceFicha): ExecuteContext => {
    const eff = effectivePermissions(
      live.allowedActions,
      live.readableDirs,
      live.canSendFiles,
      live.allowArbitrary,
      loadLocalConfig().localActionsOff,
      loadLocalConfig().localAllowArbitrary,
      loadLocalConfig().paused,
    );
    return {
      baseDir: loadLocalConfig().baseDir,
      readableDirs: eff.readableDirs,
      canSendFiles: eff.canSendFiles,
      allowArbitrary: eff.allowArbitrary,
    };
  };

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        if (loadLocalConfig().paused) {
          logLocal(`pausado: se ignora ${next.id} (${next.action}).`);
          continue;
        }
        await handleCommand(client, cred.deviceId, ficha.ownerId, next, contextFor(ficha), setState);
        // La ficha pudo cambiar (permisos): se relee barato tras cada comando.
        const fresh = await fetchDeviceFicha(client, cred.deviceId).catch(() => null);
        if (fresh !== null) {
          if (fresh.revokedAt !== null) throw new Error("PC revocado. Vuelve a vincularlo.");
          ficha = fresh;
        }
      }
    } finally {
      processing = false;
    }
  };

  const enqueue = (cmd: PendingCommand): void => {
    if (queue.some((q) => q.id === cmd.id)) return;
    if (new Date(cmd.expiresAt).getTime() <= Date.now()) return;
    // Orden de llegada (los pendientes ya vienen ordenados por created_at).
    queue.push(cmd);
    void processQueue().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : "desconocido";
      if (/revocad/i.test(msg)) {
        failOuter(new Error("PC revocado. Vuelve a vincularlo."));
        return;
      }
      logLocal(`error en cola: ${msg}`);
    });
  };

  // Al reconectar: recoge los pendientes que no hayan expirado.
  const pending = await fetchPendingCommands(client, cred.deviceId).catch(() => []);
  for (const p of pending) enqueue(p);
  setState(loadLocalConfig().paused ? "pausado" : "conectado");

  await new Promise<never>((_resolve, reject) => {
    failOuter = reject;
    const channels: RealtimeChannel[] = [];
    const cmdChannel = client.channel(`loki:desktop-cmd:${cred.deviceId}`);
    cmdChannel.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "device_commands",
        filter: `device_id=eq.${cred.deviceId}`,
      },
      (payload) => {
        const row = (payload.new ?? {}) as Record<string, unknown>;
        if (typeof row["id"] !== "string") return;
        if (typeof row["action"] !== "string" || !isDeviceAction(row["action"])) {
          logLocal(`rechazado ${String(row["id"])}: acción fuera del catálogo.`);
          return;
        }
        if (row["status"] !== "queued" && row["status"] !== "delivered") return;
        enqueue({
          id: row["id"],
          action: row["action"],
          params:
            typeof row["params"] === "object" && row["params"] !== null
              ? (row["params"] as Record<string, unknown>)
              : {},
          risk: typeof row["risk"] === "string" ? row["risk"] : "sensible",
          status: String(row["status"]),
          expiresAt: typeof row["expires_at"] === "string" ? row["expires_at"] : "",
        });
      },
    );
    cmdChannel.on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "device_commands",
        filter: `device_id=eq.${cred.deviceId}`,
      },
      (payload) => {
        const row = (payload.new ?? {}) as Record<string, unknown>;
        if (typeof row["id"] !== "string") return;
        // La tarjeta del chat ya muestra el progreso; aquí solo importa si un
        // comando vuelve a pendiente (reintento del dueño).
        if (row["status"] !== "queued" && row["status"] !== "delivered") return;
        if (typeof row["action"] !== "string" || !isDeviceAction(row["action"])) return;
        enqueue({
          id: row["id"],
          action: row["action"],
          params:
            typeof row["params"] === "object" && row["params"] !== null
              ? (row["params"] as Record<string, unknown>)
              : {},
          risk: typeof row["risk"] === "string" ? row["risk"] : "sensible",
          status: String(row["status"]),
          expiresAt: typeof row["expires_at"] === "string" ? row["expires_at"] : "",
        });
      },
    );
    // Revocación al instante: la RLS deja ver la propia ficha.
    const selfChannel = client.channel(`loki:desktop-self:${cred.deviceId}`);
    selfChannel.on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "user_devices",
        filter: `id=eq.${cred.deviceId}`,
      },
      (payload) => {
        const row = (payload.new ?? {}) as Record<string, unknown>;
        if (row["revoked_at"] !== null && row["revoked_at"] !== undefined) {
          closed = true;
          reject(new Error("PC revocado. Vuelve a vincularlo."));
        }
      },
    );
    const subscribe = (ch: RealtimeChannel): void => {
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setState(loadLocalConfig().paused ? "pausado" : "conectado");
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          if (!closed) {
            closed = true;
            reject(new Error("Se perdió la conexión con Loki."));
          }
        }
      });
      channels.push(ch);
    };
    subscribe(cmdChannel);
    subscribe(selfChannel);
    const onSignal = (): void => {
      if (!closed) {
        closed = true;
        for (const ch of channels) {
          try {
            void client.removeChannel(ch);
          } catch {
            // Al salir no importa.
          }
        }
        reject(new Error(SHUTDOWN_MESSAGE));
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function handleCommand(
  client: DeviceClient,
  deviceId: string,
  ownerId: string,
  cmd: PendingCommand,
  ctx: ExecuteContext,
  setState: (s: AgentState) => void,
): Promise<void> {
  const summary = deviceSummary(cmd.action, cmd.params);
  logLocal(`recibido ${cmd.id} (${summary}).`);
  // Doble control: la base revalida catálogo, permisos y confirmación.
  let ticket: ClaimTicket;
  try {
    ticket = await claimCommand(client, cmd.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "No se pudo tomar.";
    if (isRevokedError(reason)) throw new Error("PC revocado. Vuelve a vincularlo.");
    logLocal(`rechazado ${cmd.id}: ${reason}`);
    pushRecent({ at: new Date().toISOString(), action: cmd.action, summary: `${summary} (rechazado)`, ok: false });
    // Se informa como error para que la tarjeta no quede colgada en "en cola".
    await reportResult(client, cmd.id, false, reason.slice(0, 500), null, "").catch(() => undefined);
    return;
  }
  // Cinturón local: lo más restrictivo entre Loki y este PC.
  const localOff = loadLocalConfig().localActionsOff;
  if (localOff.includes(ticket.action)) {
    const reason = "Esa acción está apagada en este PC.";
    logLocal(`rechazado ${cmd.id}: ${reason}`);
    pushRecent({ at: new Date().toISOString(), action: cmd.action, summary: `${summary} (apagado aquí)`, ok: false });
    await reportResult(client, cmd.id, false, reason, null, "").catch(() => undefined);
    return;
  }
  const invalid = validateDeviceParams(ticket.action, ticket.params);
  if (invalid !== null) {
    logLocal(`rechazado ${cmd.id}: ${invalid}`);
    await reportResult(client, cmd.id, false, invalid, null, "").catch(() => undefined);
    return;
  }
  // Aviso visible ANTES de ejecutar: nada pasa a escondidas.
  setState("ejecutando");
  notifyCommandStart(summary);
  logLocal(`ejecutando ${cmd.id} (${summary}).`);
  let outcome: ExecuteOutcome;
  try {
    outcome = await dispatchAction(ticket.action, ticket.params, ctx);
  } catch (error) {
    outcome = {
      ok: false,
      text: error instanceof Error ? error.message.slice(0, 500) : "Falló en el PC.",
    };
  }
  // Archivos y capturas a Storage (nunca texto gigante al mensaje ni al push).
  let path: string | null = null;
  let mime = "";
  if (outcome.file !== undefined) {
    try {
      path = await uploadResultFile(client, ownerId, deviceId, outcome.file.bytes, outcome.file.filename, outcome.file.mime);
      mime = outcome.file.mime;
    } catch (error) {
      outcome = {
        ok: false,
        text: error instanceof Error ? error.message.slice(0, 500) : "No se pudo subir el archivo.",
      };
    }
  }
  await reportResult(client, cmd.id, outcome.ok, outcome.text, path, mime).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    if (isRevokedError(msg)) throw new Error("PC revocado. Vuelve a vincularlo.");
  });
  await heartbeat(client, deviceId, DESKTOP_VERSION, platformName()).catch(() => undefined);
  logLocal(`${outcome.ok ? "listo" : "falló"} ${cmd.id}: ${outcome.text.slice(0, 160)}`);
  pushRecent({
    at: new Date().toISOString(),
    action: cmd.action,
    summary,
    ok: outcome.ok,
  });
  setState(loadLocalConfig().paused ? "pausado" : "conectado");
}

/** Renueva el token de corta duración antes de que venza (sin polling). */
function scheduleTokenRefresh(client: DeviceClient): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void client.auth
        .refreshSession()
        .then(({ error }) => {
          if (error !== null) {
            logLocal(`no se pudo renovar el token: ${error.message.slice(0, 120)}`);
            return;
          }
          void client.auth.getSession().then(({ data }) => {
            const expires = data.session?.expires_at;
            if (typeof expires === "number") {
              arm(Math.max(60_000, expires * 1000 - Date.now() - 240_000));
            }
          });
        })
        .catch(() => undefined);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  };
  void client.auth.getSession().then(({ data }) => {
    const expires = data.session?.expires_at;
    if (typeof expires === "number") {
      arm(Math.max(60_000, expires * 1000 - Date.now() - 240_000));
    } else {
      arm(45 * 60_000);
    }
  });
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" || event === "USER_DELETED") {
      logLocal("sesión cerrada por el servidor; se reconectará.");
    }
  });
}

export function recentActivity(): ReturnType<typeof loadRecent> {
  return loadRecent();
}
