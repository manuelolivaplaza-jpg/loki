"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, MonitorSmartphone, ShieldAlert, X } from "lucide-react";
import { DEVICE_CATALOG, deviceSummary } from "@/lib/devices/catalog";
import { getSupabaseClient } from "@/lib/supabase/client";
import { isNativePlatform } from "@/lib/push/native";
import { useConfirmDeviceCommand, useDeviceCommand, useDevices } from "@/hooks/use-devices";
import { useSessionStore } from "@/stores/session-store";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { inputClassName } from "@/components/auth/auth-ui";
import { cn } from "@/lib/utils";

const APPROVE_TTL_MS = 5 * 60 * 1000;

async function haptic(kind: "ok" | "no"): Promise<void> {
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import("@capacitor/haptics");
    if (kind === "ok") {
      await Haptics.impact({ style: ImpactStyle.Medium });
    } else {
      await Haptics.notification({ type: NotificationType.Error });
    }
  } catch {
    // Web sin hápticos: la decisión se registra igual.
  }
}

/**
 * Pantalla de aprobación de una orden sensible al PC.
 *
 * Se abre desde la push ("Tu PC necesita tu aprobación", sin datos del PC)
 * con la app cerrada. La acción va en grande, el detalle debajo y
 * Aprobar/Rechazar a la altura del pulgar. En Android decide directo; en web
 * pide la contraseña de nuevo (fallback seguro sin la app).
 */
export function ApprovalView({ commandId }: { commandId: string }): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const { command, isPending, error, retry } = useDeviceCommand(commandId);
  const { devices } = useDevices();
  const confirmer = useConfirmDeviceCommand();
  const [now, setNow] = React.useState(() => Date.now());
  const [native, setNative] = React.useState<boolean | null>(null);
  const [password, setPassword] = React.useState("");
  const [reauthError, setReauthError] = React.useState<string | null>(null);
  const [reauthPending, setReauthPending] = React.useState(false);
  const [decided, setDecided] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    void isNativePlatform().then(setNative).catch(() => setNative(false));
  }, []);

  React.useEffect(() => {
    if (command?.status !== "pending_confirmation") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [command?.status]);

  const deviceName =
    devices.find((d) => d.id === command?.deviceId)?.name ?? "tu PC";
  const catalog = DEVICE_CATALOG.find((entry) => entry.action === command?.action);
  const leftMs =
    command === null
      ? 0
      : Math.max(0, APPROVE_TTL_MS - (now - command.createdAt.toDate().getTime()));
  const leftSecs = Math.ceil(leftMs / 1000);
  const expired = command !== null && (leftMs <= 0 || command.status === "expired");
  const actionable =
    command !== null && command.status === "pending_confirmation" && !expired;

  async function decide(ok: boolean): Promise<void> {
    setReauthError(null);
    // Web: re-autenticar con la contraseña antes de decidir (fallback seguro
    // cuando no hay app Android; en el teléfono decide directo).
    if (native === false) {
      const email = user?.email ?? "";
      if (email === "") {
        setReauthError(
          "Entra con contraseña para aprobar desde la web (o usa la app Android).",
        );
        return;
      }
      if (password === "") {
        setReauthError("Escribe tu contraseña para confirmar que eres tú.");
        return;
      }
      setReauthPending(true);
      try {
        const { error: signError } = await getSupabaseClient().auth.signInWithPassword({
          email,
          password,
        });
        if (signError !== null) {
          setReauthError("Contraseña incorrecta. Inténtalo de nuevo.");
          return;
        }
      } finally {
        setReauthPending(false);
      }
    }
    const done = await confirmer.decide(commandId, ok);
    if (done) {
      setDecided(ok);
      void haptic(ok ? "ok" : "no");
    }
  }

  if (commandId === "") {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Falta la orden"
        description="Abre esta pantalla desde la notificación de tu PC."
      />
    );
  }
  if (isPending) {
    return (
      <div className="flex flex-col items-center gap-3 py-16" aria-label="Cargando orden">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-body-sm text-muted-foreground">Cargando orden…</p>
      </div>
    );
  }
  if (command === null) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={error === null ? "Esa orden ya no existe" : "No se pudo cargar la orden"}
        description={error?.message ?? "Quizás ya se resolvió o venció."}
        action={error === null ? undefined : { label: "Reintentar", onClick: retry }}
      />
    );
  }

  if (decided !== null || !actionable) {
    const approved = decided === true || command.status === "queued" || command.status === "delivered" || command.status === "running" || command.status === "done";
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <span
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-full",
            approved ? "bg-success/15" : "bg-surface-soft",
          )}
        >
          <Icon
            icon={approved ? Check : X}
            size={32}
            className={approved ? "text-success" : "text-muted-foreground"}
          />
        </span>
        <h1 className="text-title font-semibold text-foreground">
          {expired && !approved
            ? "La orden venció"
            : approved
              ? "Aprobada: va a tu PC"
              : command.status === "rejected"
                ? "Rechazada"
                : "Ya se resolvió"}
        </h1>
        <p className="max-w-xs text-body-sm leading-5 text-muted-foreground">
          {deviceSummary(command.action, command.params)}
        </p>
        <div className="mt-2 flex w-full max-w-xs flex-col gap-2">
          <button
            type="button"
            onClick={() => router.push("/dispositivos/historial")}
            className="min-h-12 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
          >
            Ver historial
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-4 pb-40">
      <div className="flex flex-col items-center gap-2 pt-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/15">
          <Icon icon={MonitorSmartphone} size={32} className="text-warning-foreground" />
        </span>
        <p className="text-body-sm font-medium text-muted-foreground">{deviceName}</p>
        <h1 className="max-w-sm text-title font-semibold leading-8 text-foreground">
          {deviceSummary(command.action, command.params)}
        </h1>
        <p role="status" className="text-body-sm text-muted-foreground">
          {expired ? "Venció." : `Vence en ${Math.floor(leftSecs / 60)}:${String(leftSecs % 60).padStart(2, "0")}`}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-body-sm leading-5 text-foreground">
          {catalog?.detail ?? "Orden a tu PC."}
        </p>
        <p className="mt-2 text-body-sm leading-5 text-muted-foreground">
          Acción sensible: el PC la ejecuta solo con tu aprobación, y vuelve a
          comprobarla antes de correr. Queda registrada en el historial.
        </p>
      </div>

      {native === false ? (
        <label className="flex flex-col gap-1">
          <span className="text-meta leading-4 text-muted-foreground">
            Tu contraseña (para confirmar que eres tú)
          </span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className={cn(inputClassName, "min-h-12")}
          />
        </label>
      ) : null}
      {reauthError !== null ? (
        <p role="alert" className="text-body-sm text-danger">
          {reauthError}
        </p>
      ) : null}
      {confirmer.error !== null ? (
        <p role="alert" className="text-body-sm text-danger">
          {confirmer.error.message}
        </p>
      ) : null}

      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-divider bg-background/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full max-w-xl gap-2">
          <button
            type="button"
            disabled={confirmer.isPending || reauthPending || native === null}
            onClick={() => void decide(false)}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-full bg-surface-soft px-4 text-body font-semibold text-foreground outline-none interactive disabled:opacity-60"
          >
            <Icon icon={X} size={22} />
            Rechazar
          </button>
          <button
            type="button"
            disabled={confirmer.isPending || reauthPending || native === null}
            onClick={() => void decide(true)}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-full bg-foreground px-4 text-body font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            <Icon icon={Check} size={22} />
            {confirmer.isPending || reauthPending ? "Enviando…" : "Aprobar"}
          </button>
        </div>
      </div>
    </div>
  );
}
