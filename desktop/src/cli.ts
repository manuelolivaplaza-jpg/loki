#!/usr/bin/env node
/**
 * CLI del compañero (`loki-desktop link|run|unlink|status|pause|resume|
 * scripts|perms`). Sin dependencias de CLI: parsing mínimo a mano.
 *
 * En desarrollo (contra Supabase local):
 *   npm install && npm run build && node dist/cli.js link --code XXXXXX --anon <ANON_KEY>
 *   node dist/cli.js run
 * Ver desktop/README.md.
 */

import { DESKTOP_VERSION, dataDir, defaultConfig, loadLocalConfig, loadRecent, saveLocalConfig } from "./config.js";
import { clearCredential, loadCredential } from "./secure-store.js";
import { logLocal, readRecentLog } from "./logger.js";
import { listScripts, addScript, removeScript } from "./scripts-registry.js";
import { DEVICE_CATALOG, deviceLabelOf } from "./catalog.js";
import { buildTrayMenu, effectivePermissions, trayStateLabel } from "./tray-menu.js";
import { pairWithCode } from "./link.js";
import { runAgent } from "./agent.js";
import { createDeviceClient, fetchDeviceFicha, platformName, signInDevice } from "./supabase-device.js";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  return val !== undefined && !val.startsWith("--") ? val : null;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): void {
  console.log(`loki-desktop ${DESKTOP_VERSION} — compañero de escritorio de Loki
Uso:
  link --code XXXXXX [--name "Mi PC"] [--url http://127.0.0.1:54321] [--anon <ANON_KEY>]
  run                        Conecta y espera comandos (bandeja/sidecar usan esto)
  unlink                     Borra la credencial y desvincula este PC
  status [--json]            Estado, ficha en Loki y actividad reciente
  pause | resume             Dejar de aceptar comandos / volver a aceptar
  perms [--json]             Qué acciones y carpetas permite este PC
  scripts list | add <nombre> <ruta> | remove <nombre>
  help
Datos en: ${dataDir()}`);
}

async function cmdLink(): Promise<void> {
  const code = arg("--code");
  if (code === null) {
    console.error("Falta --code. Genera uno en Loki: Configuración → Mis dispositivos → Vincular un PC.");
    process.exit(1);
  }
  const url = arg("--url");
  const anon = arg("--anon");
  if (url !== null || anon !== null) {
    saveLocalConfig({
      supabaseUrl: url ?? loadLocalConfig().supabaseUrl,
      anonKey: anon ?? loadLocalConfig().anonKey,
    });
  } else if (process.env["LOKI_SUPABASE_ANON_KEY"] !== undefined) {
    saveLocalConfig({ anonKey: process.env["LOKI_SUPABASE_ANON_KEY"] ?? "" });
  }
  const name = arg("--name") ?? loadLocalConfig().deviceName;
  saveLocalConfig({ deviceName: name.slice(0, 60) });
  const id = await pairWithCode(code, name);
  logLocal(`vinculado como ${id}.`);
  console.log(`Vinculado como ${id}. Ya puedes correr: loki-desktop run`);
}

async function cmdUnlink(): Promise<void> {
  clearCredential();
  const cfg = loadLocalConfig();
  saveLocalConfig({ ...defaultConfig(), supabaseUrl: cfg.supabaseUrl, deviceName: cfg.deviceName });
  logLocal("desvinculado por el usuario.");
  console.log("Desvinculado. Para vincular de nuevo: loki-desktop link --code XXXXXX");
}

async function fetchLiveFicha(): Promise<Awaited<ReturnType<typeof fetchDeviceFicha>>> {
  const cfg = loadLocalConfig();
  const cred = await loadCredential();
  if (cred === null || cfg.deviceId === null || cfg.anonKey === "") return null;
  try {
    const client = createDeviceClient(cred.supabaseUrl, cfg.anonKey);
    await signInDevice(client, cred.email, cred.secret);
    const ficha = await fetchDeviceFicha(client, cfg.deviceId);
    await client.auth.signOut().catch(() => undefined);
    return ficha;
  } catch {
    return null;
  }
}

async function cmdStatus(asJson: boolean): Promise<void> {
  const cfg = loadLocalConfig();
  const cred = await loadCredential();
  const ficha = await fetchLiveFicha();
  const eff =
    ficha === null
      ? null
      : effectivePermissions(
          ficha.allowedActions,
          ficha.readableDirs,
          ficha.canSendFiles,
          ficha.allowArbitrary,
          cfg.localActionsOff,
          cfg.localAllowArbitrary,
          cfg.paused,
        );
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          version: DESKTOP_VERSION,
          platform: platformName(),
          linked: cred !== null && cfg.deviceId !== null,
          deviceId: cfg.deviceId,
          paused: cfg.paused,
          server: ficha,
          effective: eff,
          recent: loadRecent(),
          menu: buildTrayMenu(
            cred === null ? "vincular" : cfg.paused ? "pausado" : ficha === null ? "desconectado" : "conectado",
            cfg.paused,
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (cred === null || cfg.deviceId === null) {
    console.log("Sin vincular. Usa: loki-desktop link --code XXXXXX");
    return;
  }
  console.log(`PC: ${cfg.deviceName} (${cfg.deviceId})`);
  console.log(`Estado en Loki: ${ficha === null ? "no se pudo leer (¿sin red?)" : ficha.revokedAt !== null ? "REVOCADO" : "activo"}`);
  console.log(`Pausado aquí: ${cfg.paused ? "sí" : "no"}`);
  if (eff !== null) {
    console.log("Acciones efectivas (Loki ∩ este PC):");
    for (const a of eff.effectiveActions) console.log(`  - ${a} (${deviceLabelOf(a)})`);
    console.log(`Carpetas: ${eff.readableDirs.length === 0 ? "ninguna" : eff.readableDirs.join(", ")}`);
    console.log(`Arbitrarios: ${eff.allowArbitrary ? "habilitados" : "apagados"}`);
  }
  const recent = loadRecent();
  if (recent.length > 0) {
    console.log("Reciente:");
    for (const r of recent.slice(0, 5)) console.log(`  ${r.at} ${r.ok ? "✓" : "✗"} ${r.summary}`);
  }
}

async function cmdPerms(asJson: boolean): Promise<void> {
  const cfg = loadLocalConfig();
  const ficha = await fetchLiveFicha();
  if (ficha === null) {
    console.error("No se pudo leer la ficha en Loki (¿sin red o sin vincular?).");
    process.exit(1);
  }
  const eff = effectivePermissions(
    ficha.allowedActions,
    ficha.readableDirs,
    ficha.canSendFiles,
    ficha.allowArbitrary,
    cfg.localActionsOff,
    cfg.localAllowArbitrary,
    cfg.paused,
  );
  if (asJson) {
    console.log(JSON.stringify(eff, null, 2));
    return;
  }
  console.log("Permisos de este PC (siempre gana lo más restrictivo):");
  for (const entry of DEVICE_CATALOG) {
    const on = eff.effectiveActions.includes(entry.action);
    const why = !on
      ? eff.localOff.includes(entry.action)
        ? "apagada aquí"
        : "apagada en Loki"
      : "permitida";
    console.log(`  [${on ? "x" : " "}] ${entry.action} — ${why}`);
  }
  console.log(`Carpetas legibles: ${eff.readableDirs.length === 0 ? "ninguna" : eff.readableDirs.join(", ")}`);
  console.log(`Puede mandar archivos: ${eff.canSendFiles ? "sí" : "no"}`);
  console.log(`Arbitrarios: ${eff.allowArbitrary ? "habilitados (doble opt-in)" : "apagados"}`);
}

async function cmdScripts(): Promise<void> {
  const sub = process.argv[3];
  if (sub === "list" || sub === undefined) {
    const all = listScripts();
    if (all.length === 0) {
      console.log("Sin scripts. Agrega uno: loki-desktop scripts add <nombre> <ruta>");
      return;
    }
    for (const s of all) console.log(`${s.name} → ${s.path}`);
    return;
  }
  if (sub === "add") {
    const name = process.argv[4];
    const ruta = process.argv[5];
    if (name === undefined || ruta === undefined) {
      console.error("Uso: loki-desktop scripts add <nombre> <ruta>");
      process.exit(1);
    }
    const entry = await addScript(name, ruta, loadLocalConfig().baseDir);
    logLocal(`script registrado: ${entry.name} → ${entry.path}`);
    console.log(`Registrado "${entry.name}". Desde Loki: pídele correr el script "${entry.name}".`);
    return;
  }
  if (sub === "remove") {
    const name = process.argv[4];
    if (name === undefined) {
      console.error("Uso: loki-desktop scripts remove <nombre>");
      process.exit(1);
    }
    console.log(removeScript(name) ? "Borrado." : "No había un script con ese nombre.");
    return;
  }
  console.error("Uso: loki-desktop scripts list | add <nombre> <ruta> | remove <nombre>");
  process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case "link":
        await cmdLink();
        break;
      case "run":
        console.log(`Loki escritorio ${DESKTOP_VERSION}: conectado, esperando órdenes (Ctrl+C para salir).`);
        await runAgent({
          onState: (s) => console.log(`Estado: ${trayStateLabel(s)}`),
        });
        break;
      case "unlink":
        await cmdUnlink();
        break;
      case "status":
        await cmdStatus(has("--json"));
        break;
      case "pause":
        saveLocalConfig({ paused: true });
        logLocal("pausado por el usuario (no acepta comandos).");
        console.log("Pausado: no acepta comandos hasta `resume`.");
        break;
      case "resume":
        saveLocalConfig({ paused: false });
        logLocal("reanudado por el usuario.");
        console.log("Reanudado: vuelve a aceptar comandos.");
        break;
      case "perms":
        await cmdPerms(has("--json"));
        break;
      case "scripts":
        await cmdScripts();
        break;
      case "log":
        for (const line of readRecentLog(30)) console.log(line);
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        usage();
        break;
      default:
        console.error(`Comando desconocido: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Error desconocido.");
    process.exit(1);
  }
}

await main();
