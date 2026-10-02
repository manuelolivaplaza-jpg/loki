/**
 * Aviso visible en el PC cada vez que se ejecuta algo.
 *
 * Nada pasa a escondidas: antes de ejecutar, el compañero muestra una
 * notificación del sistema ("Loki: tomando una captura pedida desde tu
 * teléfono"). Sin dependencias externas: PowerShell inbox en Windows,
 * `osascript` en macOS y `notify-send` en Linux.
 */

import { execFile } from "node:child_process";

function runDetached(cmd: string, args: string[]): void {
  try {
    const child = execFile(cmd, args, { timeout: 10000, windowsHide: true }, () => undefined);
    child.unref();
  } catch {
    // Notificar nunca rompe la ejecución.
  }
}

function powershellToast(title: string, body: string): void {
  const safe = (s: string): string =>
    s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, "`\"").slice(0, 300);
  // Toast inbox (Windows 10/11) sin módulos extra; si falla, no pasa nada.
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode("${safe(title)}")) | Out-Null;`,
    `$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode("${safe(body)}")) | Out-Null;`,
  ].join(" ");
  runDetached("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

export function notify(title: string, body: string): void {
  const shortTitle = title.slice(0, 120);
  const shortBody = body.slice(0, 300);
  if (process.platform === "win32") {
    powershellToast(shortTitle, shortBody);
    return;
  }
  if (process.platform === "darwin") {
    runDetached("osascript", ["-e", `display notification "${shortBody}" with title "${shortTitle}"`]);
    return;
  }
  runDetached("notify-send", [shortTitle, shortBody]);
}

/** "Loki: tomando una captura pedida desde tu teléfono". */
export function notifyCommandStart(summary: string): void {
  notify("Loki en este PC", `${summary} (pedido desde Loki)`);
}

export function notifyRevoked(): void {
  notify("Loki en este PC", "Este PC fue desvinculado desde Loki. Ya no acepta órdenes.");
}
