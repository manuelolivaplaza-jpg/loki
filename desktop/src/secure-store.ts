/**
 * Almacén seguro de la credencial del dispositivo.
 *
 * La credencial (email del dispositivo + secreto largo) NUNCA queda en texto
 * plano en el disco:
 *   Windows: se cifra con DPAPI (ámbito CurrentUser) vía PowerShell inbox y
 *     solo el blob cifrado vive en `%APPDATA%/loki-desktop/vault.dpapi`.
 *   macOS/Linux: archivo con modo 0600 (mejor esfuerzo hasta integrar el
 *     llavero del sistema; ver desktop/README.md).
 *
 * Si la credencial se revoca desde Loki, `clearCredential()` la borra y la app
 * vuelve a la pantalla de vinculación.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { dataDir } from "./config.js";

export interface DeviceCredential {
  deviceId: string;
  email: string;
  secret: string;
  supabaseUrl: string;
}

function vaultPath(): string {
  return join(dataDir(), process.platform === "win32" ? "vault.dpapi" : "vault.json");
}

function runPowershell(script: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() === "" ? error.message : stderr.trim()));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined && child.stdin !== null) {
      child.stdin.write(stdin, (err) => {
        if (err !== null) reject(err);
        else child.stdin?.end();
      });
    }
  });
}

async function dpapiProtect(plainJson: string): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$raw = [Console]::In.ReadToEnd();",
    "$bytes = [Text.Encoding]::UTF8.GetBytes($raw);",
    "$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser');",
    "[Convert]::ToBase64String($enc)",
  ].join(" ");
  const out = await runPowershell(script, plainJson);
  return out.trim();
}

async function dpapiUnprotect(blobB64: string): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$raw = [Console]::In.ReadToEnd();",
    "$enc = [Convert]::FromBase64String($raw.Trim());",
    "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser');",
    "[Text.Encoding]::UTF8.GetString($bytes)",
  ].join(" ");
  const out = await runPowershell(script, blobB64);
  return out.trim();
}

function isCredential(value: unknown): value is DeviceCredential {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["deviceId"] === "string" &&
    typeof rec["email"] === "string" &&
    typeof rec["secret"] === "string" &&
    typeof rec["supabaseUrl"] === "string" &&
    rec["secret"] !== ""
  );
}

export async function saveCredential(cred: DeviceCredential): Promise<void> {
  mkdirSync(dataDir(), { recursive: true });
  const plain = JSON.stringify(cred);
  if (process.platform === "win32") {
    const blob = await dpapiProtect(plain);
    writeFileSync(vaultPath(), blob + "\n", "utf8");
    return;
  }
  writeFileSync(vaultPath(), plain + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(vaultPath(), 0o600);
  } catch {
    // Mejor esfuerzo: el archivo ya nació con 0600.
  }
}

export async function loadCredential(): Promise<DeviceCredential | null> {
  let raw: string;
  try {
    raw = readFileSync(vaultPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const plain = process.platform === "win32" ? await dpapiUnprotect(raw) : raw;
    const parsed: unknown = JSON.parse(plain) as unknown;
    return isCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCredential(): void {
  try {
    unlinkSync(vaultPath());
  } catch {
    // Si no había nada, ya está desvinculado.
  }
}
