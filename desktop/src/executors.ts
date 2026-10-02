/**
 * Ejecución local del catálogo cerrado (Windows primero, portable después).
 *
 * Reglas (siempre gana lo más restrictivo):
 * - La acción debe estar en el catálogo, habilitada en Loki (ficha del PC) y
 *   no apagada aquí (`localActionsOff`).
 * - Lo sensible exige confirmación registrada en la base: la comprueba
 *   `device_claim_command` antes de ejecutar (aquí nunca llega sin ticket).
 * - Rutas siempre dentro de la base local + carpetas permitidas (ver
 *   `path-guard.ts`): ojo con `..`, enlaces simbólicos y rutas UNC.
 * - `arbitrary_exec` exige true en Loki Y aquí, corre con tiempo límite y
 *   salida truncada, sin privilegios de administrador (nunca se eleva).
 * - Sin LLM, sin red salvo subir el resultado a Storage.
 */

import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { cpus, freemem, hostname, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, statSync, readFileSync, unlinkSync } from "node:fs";
import type { DeviceAction } from "./catalog.js";
import { validateDeviceParams } from "./catalog.js";
import { dirAllowed, resolveInsideBase } from "./path-guard.js";
import { findScript } from "./scripts-registry.js";

export interface ExecuteContext {
  baseDir: string;
  /** Carpetas legibles efectivas (Loki ∩ local; vacío = ninguna). */
  readableDirs: string[];
  canSendFiles: boolean;
  allowArbitrary: boolean;
}

export interface ExecuteOutcome {
  ok: boolean;
  /** Texto corto (máx 8000, la base lo corta). */
  text: string;
  file?: { bytes: Uint8Array; filename: string; mime: string };
}

const OUTPUT_LIMIT = 4000;
const FIND_LIMIT = 20;
const SEND_MAX_BYTES = 25 * 1024 * 1024;

function truncate(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_LIMIT ? t.slice(0, OUTPUT_LIMIT) + "… (salida truncada)" : t;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; shell?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        cwd: opts.cwd,
        shell: opts.shell ?? false,
      },
      (error, stdout, stderr) => {
        const code =
          error !== null && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error !== null
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    child.on("error", () => resolve({ stdout: "", stderr: "No se pudo lanzar el proceso.", code: 1 }));
  });
}

function openDetached(target: string): void {
  // Abrir y soltar: el resultado se informa igual (el PC no espera a la app).
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", '""', target], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore" });
  child.unref();
}

function mimeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  return "application/octet-stream";
}

async function execStatus(): Promise<ExecuteOutcome> {
  const totalGb = (totalmem() / 1024 ** 3).toFixed(1);
  const freeGb = (freemem() / 1024 ** 3).toFixed(1);
  const upH = Math.floor(uptime() / 3600);
  const load = cpus().length > 0 ? `CPUs: ${cpus().length}` : "CPU desconocida";
  let battery = "batería desconocida";
  try {
    if (process.platform === "win32") {
      const r = await runCmd("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1 EstimatedChargeRemaining).EstimatedChargeRemaining",
      ], { timeoutMs: 10000 });
      const n = parseInt(r.stdout.trim(), 10);
      if (Number.isFinite(n)) battery = `batería ${n}%`;
    }
  } catch {
    // Mejor esfuerzo: el estado nunca falla por la batería.
  }
  return {
    ok: true,
    text: `${hostname()}: encendido hace ${upH} h, RAM libre ${freeGb}/${totalGb} GB, ${load}, ${battery}.`,
  };
}

async function execFindFiles(
  params: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteOutcome> {
  const query = typeof params["text"] === "string" ? params["text"].trim().toLowerCase() : "";
  const dir = typeof params["dir"] === "string" ? params["dir"] : "";
  const scope = dir === "" ? ctx.readableDirs : [dir];
  for (const d of scope) {
    if (!dirAllowed(d, ctx.readableDirs)) {
      return { ok: false, text: "Esa carpeta no está permitida en este PC." };
    }
  }
  const found: string[] = [];
  let visited = 0;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (found.length >= FIND_LIMIT || visited > 400 || depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= FIND_LIMIT || visited > 400) return;
      visited += 1;
      if (name.startsWith(".") || name === "node_modules") continue;
      const childAbs = join(abs, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let isDir = false;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(childAbs, childRel, depth + 1);
      } else if (name.toLowerCase().includes(query)) {
        found.push(childRel);
      }
    }
  };
  for (const d of scope) {
    const abs = await resolveInsideBase(ctx.baseDir, d).catch(() => null);
    if (abs === null) continue;
    walk(abs, d.replace(/^[/\\]+|[/\\]+$/g, ""), 0);
  }
  if (found.length === 0) return { ok: true, text: `No encontré nada con "${query}" en las carpetas permitidas.` };
  return { ok: true, text: `Encontré ${found.length}:\n${found.join("\n")}` };
}

async function execSendFile(
  params: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteOutcome> {
  if (!ctx.canSendFiles) {
    return { ok: false, text: "Este PC no puede mandar archivos al chat." };
  }
  const wanted = typeof params["text"] === "string" ? params["text"] : "";
  const dir = typeof params["dir"] === "string" && params["dir"] !== "" ? params["dir"] : undefined;
  if (dir !== undefined && !dirAllowed(dir, ctx.readableDirs)) {
    return { ok: false, text: "Esa carpeta no está permitida en este PC." };
  }
  let abs: string;
  try {
    abs = await resolveInsideBase(ctx.baseDir, wanted, dir);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : "Esa ruta no está permitida." };
  }
  let bytes: Uint8Array;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ok: false, text: "Eso no es un archivo." };
    if (st.size > SEND_MAX_BYTES) return { ok: false, text: "El archivo es muy grande (máx 25 MB)." };
    bytes = readFileSync(abs);
  } catch {
    return { ok: false, text: "No se pudo leer ese archivo." };
  }
  const filename = abs.split(/[\\/]/).pop() ?? "archivo";
  return { ok: true, text: `Archivo listo: ${filename}.`, file: { bytes, filename, mime: mimeFor(filename) } };
}

async function execScreenshot(): Promise<ExecuteOutcome> {
  const out = join(tmpdir(), `loki-shot-${Date.now()}.png`);
  try {
    if (process.platform === "win32") {
      const full = [
        "Add-Type -AssemblyName System.Drawing;",
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$r = [Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp = New-Object Drawing.Bitmap($r.Width, $r.Height);",
        "$g = [Drawing.Graphics]::FromImage($bmp);",
        `$g.CopyFromScreen($r.X, $r.Y, 0, 0, $bmp.Size);`,
        `$bmp.Save('${out.replace(/'/g, "''")}', [Drawing.Imaging.ImageFormat]::Png);`,
        "$g.Dispose(); $bmp.Dispose();",
      ].join(" ");
      const r = await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", full], {
        timeoutMs: 20000,
      });
      if (r.code !== 0) return { ok: false, text: "No se pudo tomar la captura en este PC." };
    } else if (process.platform === "darwin") {
      const r = await runCmd("screencapture", ["-x", "-t", "png", out], { timeoutMs: 20000 });
      if (r.code !== 0) return { ok: false, text: "No se pudo tomar la captura en este PC." };
    } else {
      // Linux: prueba herramientas comunes, en orden.
      const tried = [
        ["grim", [out]],
        ["import", ["-window", "root", out]],
        ["gnome-screenshot", ["-f", out]],
      ] as const;
      let done = false;
      for (const [bin, args] of tried) {
        const r = await runCmd(bin, [...args], { timeoutMs: 20000 }).catch(() => null);
        if (r !== null && r.code === 0) {
          done = true;
          break;
        }
      }
      if (!done) return { ok: false, text: "Este PC no tiene herramienta de captura (grim/import)." };
    }
    const bytes = readFileSync(out);
    return {
      ok: true,
      text: "Captura tomada.",
      file: { bytes: new Uint8Array(bytes), filename: "captura.png", mime: "image/png" },
    };
  } catch {
    return { ok: false, text: "No se pudo tomar la captura en este PC." };
  } finally {
    try {
      unlinkSync(out);
    } catch {
      // El temporal ya se leyó o nunca existió.
    }
  }
}

async function execLockScreen(): Promise<ExecuteOutcome> {
  if (process.platform === "win32") {
    const r = await runCmd("rundll32.exe", ["user32.dll,LockWorkStation"], { timeoutMs: 10000 });
    return r.code === 0
      ? { ok: true, text: "Pantalla bloqueada." }
      : { ok: false, text: "No se pudo bloquear la pantalla." };
  }
  if (process.platform === "darwin") {
    const r = await runCmd("pmset", ["displaysleepnow"], { timeoutMs: 10000 });
    return r.code === 0
      ? { ok: true, text: "Pantalla en reposo." }
      : { ok: false, text: "No se pudo bloquear la pantalla." };
  }
  const r = await runCmd("loginctl", ["lock-session"], { timeoutMs: 10000 });
  if (r.code === 0) return { ok: true, text: "Pantalla bloqueada." };
  const fallback = await runCmd("xdg-screensaver", ["lock"], { timeoutMs: 10000 });
  return fallback.code === 0
    ? { ok: true, text: "Pantalla bloqueada." }
    : { ok: false, text: "No se pudo bloquear la pantalla en este PC." };
}

async function execVolume(params: Record<string, unknown>): Promise<ExecuteOutcome> {
  if (params["muted"] === true) {
    if (process.platform === "darwin") {
      await runCmd("osascript", ["-e", "set volume with output muted"], { timeoutMs: 10000 });
      return { ok: true, text: "Sonido silenciado." };
    }
    if (process.platform === "linux") {
      await runCmd("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "1"], { timeoutMs: 10000 });
      return { ok: true, text: "Sonido silenciado." };
    }
    // Windows sin dependencias: nivel 0 (limitación documentada en el README).
    const r = await runCmd("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -MemberDefinition '[DllImport(\"winmm.dll\")] public static extern int waveOutSetVolume(IntPtr h, uint v);' -Name WinVol -Namespace Loki; [Loki.WinVol]::waveOutSetVolume([IntPtr]::Zero, 0) | Out-Null",
    ], { timeoutMs: 10000 });
    return r.code === 0
      ? { ok: true, text: "Sonido silenciado (volumen 0)." }
      : { ok: false, text: "No se pudo silenciar en este PC." };
  }
  const level = typeof params["level"] === "number" ? Math.round(params["level"]) : NaN;
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    return { ok: false, text: "El volumen va de 0 a 100." };
  }
  if (process.platform === "darwin") {
    const r = await runCmd("osascript", ["-e", `set volume output volume ${level}`], { timeoutMs: 10000 });
    return r.code === 0
      ? { ok: true, text: `Volumen en ${level}.` }
      : { ok: false, text: "No se pudo cambiar el volumen." };
  }
  if (process.platform === "linux") {
    const r = await runCmd("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${level}%`], { timeoutMs: 10000 });
    if (r.code === 0) return { ok: true, text: `Volumen en ${level}.` };
    const fallback = await runCmd("amixer", ["-D", "pulse", "sset", "Master", `${level}%`], { timeoutMs: 10000 });
    return fallback.code === 0
      ? { ok: true, text: `Volumen en ${level}.` }
      : { ok: false, text: "No se pudo cambiar el volumen en este PC." };
  }
  const v = Math.round((level / 100) * 65535);
  const both = (v | (v << 16)) >>> 0;
  const r = await runCmd("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Add-Type -MemberDefinition '[DllImport("winmm.dll")] public static extern int waveOutSetVolume(IntPtr h, uint v);' -Name WinVol -Namespace Loki; [Loki.WinVol]::waveOutSetVolume([IntPtr]::Zero, ${both}) | Out-Null`,
  ], { timeoutMs: 10000 });
  return r.code === 0
    ? { ok: true, text: `Volumen en ${level}.` }
    : { ok: false, text: "No se pudo cambiar el volumen." };
}

async function execMedia(params: Record<string, unknown>): Promise<ExecuteOutcome> {
  const op = typeof params["op"] === "string" ? params["op"] : "";
  if (process.platform === "win32") {
    const code = op === "next" ? 0xb0 : op === "prev" ? 0xb1 : 0xb3;
    const script = [
      "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);' -Name MediaKeys -Namespace Loki;",
      `[Loki.MediaKeys]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50;`,
      `[Loki.MediaKeys]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero);`,
    ].join(" ");
    const r = await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeoutMs: 10000,
    });
    if (r.code !== 0) return { ok: false, text: "No se pudo mandar la orden multimedia." };
    const label = op === "next" ? "siguiente" : op === "prev" ? "anterior" : "pausa/reproducir";
    return { ok: true, text: `Multimedia: ${label}.` };
  }
  if (process.platform === "linux") {
    const r = await runCmd("playerctl", [op === "toggle" ? "play-pause" : op], { timeoutMs: 10000 });
    return r.code === 0
      ? { ok: true, text: `Multimedia: ${op}.` }
      : { ok: false, text: "Este PC no tiene playerctl para multimedia." };
  }
  return { ok: false, text: "Multimedia no soportado en este sistema." };
}

async function execScript(
  params: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteOutcome> {
  const name = typeof params["text"] === "string" ? params["text"].trim() : "";
  const entry = findScript(name);
  if (entry === null) {
    return { ok: false, text: `No hay un script llamado "${name}" en este PC. Agrégalo en la app de escritorio.` };
  }
  // La ruta quedó fija al registrar; igual se revalida que siga dentro.
  const abs = await resolveInsideBase(ctx.baseDir, entry.path).catch(() => null);
  if (abs === null || abs !== entry.path) {
    return { ok: false, text: "Ese script quedó fuera de las carpetas permitidas." };
  }
  const lower = entry.path.toLowerCase();
  let cmd = "";
  let args: string[] = [];
  if (lower.endsWith(".ps1")) {
    cmd = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", entry.path];
  } else if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    cmd = "cmd.exe";
    args = ["/c", entry.path];
  } else if (lower.endsWith(".sh")) {
    cmd = "sh";
    args = [entry.path];
  } else {
    return { ok: false, text: "Ese script ya no tiene una extensión permitida." };
  }
  const r = await runCmd(cmd, args, { timeoutMs: 60000 });
  const out = truncate(`${r.stdout}\n${r.stderr}`.trim());
  if (r.code === 0) {
    return { ok: true, text: out === "" ? `Script "${name}" listo (sin salida).` : `Script "${name}":\n${out}` };
  }
  return { ok: false, text: out === "" ? `El script "${name}" falló.` : `El script "${name}" falló:\n${out}` };
}

async function execArbitrary(
  params: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteOutcome> {
  if (!ctx.allowArbitrary) {
    return { ok: false, text: "Los comandos arbitrarios están apagados en este PC." };
  }
  const text = typeof params["text"] === "string" ? params["text"].trim() : "";
  if (text === "") return { ok: false, text: "Falta el comando a ejecutar." };
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", text]
      : ["-c", text];
  mkdirSync(ctx.baseDir, { recursive: true });
  const r = await runCmd(shell, args, { timeoutMs: 30000, cwd: ctx.baseDir });
  const out = truncate(`${r.stdout}\n${r.stderr}`.trim());
  if (r.code === 0) {
    return { ok: true, text: out === "" ? "Listo (sin salida)." : out };
  }
  return { ok: false, text: out === "" ? "El comando falló (sin salida)." : `Falló:\n${out}` };
}

/**
 * Ejecuta una acción ya reclamada (con ticket de la base). Lo que no entiende
 * o no tiene habilitado se rechaza con el motivo (ok:false + texto).
 */
export async function dispatchAction(
  action: DeviceAction,
  params: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteOutcome> {
  const invalid = validateDeviceParams(action, params);
  if (invalid !== null) return { ok: false, text: invalid };
  switch (action) {
    case "pc_status":
      return execStatus();
    case "open_app": {
      const app = typeof params["text"] === "string" ? params["text"].trim() : "";
      try {
        openDetached(app);
        return { ok: true, text: `Abriendo ${app.slice(0, 80)}.` };
      } catch {
        return { ok: false, text: "No se pudo abrir esa aplicación." };
      }
    }
    case "open_url": {
      const url = typeof params["text"] === "string" ? params["text"].trim() : "";
      if (!/^https:\/\/[^ ]+$/.test(url)) return { ok: false, text: "Solo URLs https válidas." };
      try {
        openDetached(url);
        return { ok: true, text: `Abriendo ${url.slice(0, 120)} en el navegador.` };
      } catch {
        return { ok: false, text: "No se pudo abrir ese enlace." };
      }
    }
    case "find_files":
      return execFindFiles(params, ctx);
    case "send_file":
      return execSendFile(params, ctx);
    case "screenshot":
      return execScreenshot();
    case "lock_screen":
      return execLockScreen();
    case "volume_set":
      return execVolume(params);
    case "media_control":
      return execMedia(params);
    case "run_script":
      return execScript(params, ctx);
    case "arbitrary_exec":
      return execArbitrary(params, ctx);
    default:
      return { ok: false, text: "Esa acción no existe en el catálogo." };
  }
}

export function tempScratchDir(): string {
  const dir = join(tmpdir(), "loki-desktop");
  mkdirSync(dir, { recursive: true });
  return dir;
}
