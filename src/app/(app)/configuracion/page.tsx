"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Brain, ChevronRight, LogOut } from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { ThemeSegmented } from "@/components/shell/theme-segmented";
import { Toggle } from "@/components/ui/toggle";
import { signOutUser } from "@/lib/auth/actions";
import { getLokiStatus } from "@/lib/ai/loki";
import { isPushConfigured, registerPushToken } from "@/lib/push/fcm";
import { isNativePlatform, registerNativePush } from "@/lib/push/native";
import { DEFAULT_PREFS } from "@/lib/data/notifications";
import { GcalSection } from "@/components/calendar/gcal-section";
import { AiUsageSection } from "@/components/ai/ai-usage-section";
import { useMembers } from "@/hooks/use-chat";
import { useWorkspaces } from "@/stores/workspace-store";
import { MembersSection } from "@/components/members/members-section";
import {
  useNotificationPrefs,
  useSaveNotificationPrefs,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { NotificationPrefs } from "@/types/organizer";
import { cn } from "@/lib/utils";

const PREF_ROWS: readonly { key: keyof Omit<NotificationPrefs, "quietStart" | "quietEnd">; label: string; detail: string }[] = [
  { key: "mention", label: "Menciones", detail: "Cuando te nombran con @" },
  { key: "reply", label: "Respuestas", detail: "Respuestas a tus mensajes e hilos" },
  { key: "reaction", label: "Reacciones", detail: "Cuando reaccionan a lo tuyo" },
  { key: "task_assigned", label: "Tareas asignadas", detail: "Cuando te asignan una tarea" },
  { key: "task_due", label: "Vencimientos", detail: "Tareas por vencer y recordatorios" },
  { key: "event_reminder", label: "Eventos", detail: "Recordatorios del calendario" },
  { key: "invite", label: "Invitaciones", detail: "Cuando alguien se une por tu link" },
  { key: "ai_alert", label: "Avisos de Loki", detail: "Alertas del asistente" },
  { key: "list", label: "Listas", detail: "Novedades de las listas compartidas" },
  { key: "poll", label: "Encuestas", detail: "Cuando falta tu voto antes del cierre" },
  { key: "memory", label: "Memoria", detail: "Recuerdos nuevos o por caducar del espacio" },
];

export default function ConfiguracionPage(): React.JSX.Element {
  const router = useRouter();
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [pushEnabled, setPushEnabled] = React.useState(false);
  const [pushStatus, setPushStatus] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);
  // Estado real del proveedor (Edge Function `loki-chat`): sin clave muestra
  // "Sin configurar". De solo lectura desde el cliente.
  const [lokiConfigured, setLokiConfigured] = React.useState<boolean | null>(null);
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const membersQuery = useMembers(currentWorkspaceId);
  const myRole = (membersQuery.data ?? []).find((m) => m.uid === user?.uid)?.role ?? "member";
  const isSpaceAdmin = myRole === "owner" || myRole === "admin";
  const prefsQuery = useNotificationPrefs(user?.uid ?? null);
  const savePrefs = useSaveNotificationPrefs();
  const [prefsError, setPrefsError] = React.useState<string | null>(null);
  const prefs: NotificationPrefs = prefsQuery.data ?? DEFAULT_PREFS;

  function handlePrefChange(next: NotificationPrefs): void {
    if (user === null) return;
    setPrefsError(null);
    savePrefs.mutate(
      { uid: user.uid, prefs: next },
      { onError: (err) => setPrefsError(err.message) },
    );
  }

  React.useEffect(() => {
    let cancelled = false;
    void getLokiStatus().then((status) => {
      if (!cancelled) setLokiConfigured(status.configured);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePushChange(next: boolean): Promise<void> {
    if (!next) {
      setPushEnabled(false);
      setPushStatus(null);
      return;
    }
    // En la app Android se registra el token nativo (FCM vía
    // google-services.json); en web, el token del navegador.
    try {
      if (await isNativePlatform()) {
        await registerNativePush((link) => {
          router.push(link);
        });
        setPushEnabled(true);
        setPushStatus(null);
        return;
      }
    } catch (error) {
      setPushStatus(
        error instanceof Error ? error.message : "No se pudo activar las notificaciones.",
      );
      return;
    }
    if (!isPushConfigured()) {
      setPushStatus("Notificaciones no configuradas en este entorno.");
      return;
    }
    try {
      await registerPushToken();
      setPushEnabled(true);
      setPushStatus(null);
    } catch {
      setPushStatus("No se pudo activar las notificaciones.");
    }
  }

  React.useEffect(() => {
    setMounted(true);
    // El interruptor refleja el estado real: permiso ya otorgado antes.
    void (async () => {
      try {
        if (await isNativePlatform()) {
          const { PushNotifications } = await import("@capacitor/push-notifications");
          const current = await PushNotifications.checkPermissions();
          if (current.receive === "granted") setPushEnabled(true);
          return;
        }
      } catch {
        return;
      }
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        isPushConfigured()
      ) {
        setPushEnabled(true);
      }
    })();
  }, []);

  const themeLabel =
    mounted && (theme === "dark" || resolvedTheme === "dark")
      ? "Oscuro"
      : "Claro";

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOutUser();
    } finally {
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-6 md:py-8">
      <section aria-label="Apariencia">
        <SectionLabel>Apariencia</SectionLabel>
        <Card className="p-2">
          <CardRow minHeight="14" className="px-2">
            <span className="min-w-0 flex-1 text-body text-foreground">
              Tema
            </span>
            <span className="text-body-sm text-muted-foreground">
              {themeLabel}
            </span>
          </CardRow>
          <CardDivider className="mx-2" />
          <div className="px-2 pb-2 pt-2">
            <ThemeSegmented />
          </div>
        </Card>
      </section>

      <section aria-label="Notificaciones">
        <SectionLabel>Notificaciones</SectionLabel>
        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Notificaciones push
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Avisos de actividad en tus espacios
              </span>
            </span>
            <Toggle
              checked={pushEnabled}
              onCheckedChange={(checked) => void handlePushChange(checked)}
              label="Notificaciones push"
            />
          </CardRow>
          {pushStatus !== null ? (
            <>
              <CardDivider />
              <CardRow minHeight="12">
                <span role="status" className="text-body-sm leading-5 text-muted-foreground">
                  {pushStatus}
                </span>
              </CardRow>
            </>
          ) : null}
          <CardDivider />
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Horario de silencio
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Sin avisos en ese rango
              </span>
            </span>
          </CardRow>
          <div className="flex items-center gap-3 px-4 pb-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-meta text-muted-foreground">Desde</span>
              <input
                type="time"
                aria-label="Silencio desde"
                value={prefs.quietStart ?? ""}
                onChange={(formEvent) =>
                  handlePrefChange({ ...prefs, quietStart: formEvent.target.value === "" ? null : formEvent.target.value })
                }
                className="h-11 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-meta text-muted-foreground">Hasta</span>
              <input
                type="time"
                aria-label="Silencio hasta"
                value={prefs.quietEnd ?? ""}
                onChange={(formEvent) =>
                  handlePrefChange({ ...prefs, quietEnd: formEvent.target.value === "" ? null : formEvent.target.value })
                }
                className="h-11 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
              />
            </label>
          </div>
          <CardDivider />
          {PREF_ROWS.map((row, index) => (
            <React.Fragment key={row.key}>
              {index > 0 ? <CardDivider /> : null}
              <CardRow>
                <span className="min-w-0 flex-1">
                  <span className="block text-body leading-6 text-foreground">
                    {row.label}
                  </span>
                  <span className="block text-body-sm leading-5 text-muted-foreground">
                    {row.detail}
                  </span>
                </span>
                <Toggle
                  checked={prefs[row.key]}
                  onCheckedChange={(checked) => handlePrefChange({ ...prefs, [row.key]: checked })}
                  label={row.label}
                />
              </CardRow>
            </React.Fragment>
          ))}
          {prefsError !== null ? (
            <>
              <CardDivider />
              <CardRow minHeight="12">
                <span role="alert" className="text-body-sm leading-5 text-danger">
                  {prefsError}
                </span>
              </CardRow>
            </>
          ) : null}
        </Card>
      </section>

      <section aria-label="Loki IA">
        <SectionLabel>Loki IA</SectionLabel>
        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Asistente personal
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Pregúntale a Loki por tus días, tu semana o un recordatorio
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
                lokiConfigured === true
                  ? "bg-success/15 text-success"
                  : "bg-surface text-muted-foreground",
              )}
            >
              {lokiConfigured === null
                ? "Comprobando…"
                : lokiConfigured
                  ? "Disponible"
                  : "Sin configurar"}
            </span>
          </CardRow>
          {lokiConfigured === false ? (
            <>
              <CardDivider />
              <CardRow minHeight="12">
                <span className="text-body-sm leading-5 text-muted-foreground">
                  Loki IA sin configurar. Pide al administrador que configure
                  el proveedor.
                </span>
              </CardRow>
            </>
          ) : null}
        </Card>
      </section>

      <GcalSection />

      <section aria-label="Memoria">
        <SectionLabel>Memoria del espacio</SectionLabel>
        <Card>
          <CardRow
            role="link"
            tabIndex={0}
            onClick={() => router.push("/memoria")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                router.push("/memoria");
              }
            }}
            className="cursor-pointer outline-none"
          >
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground dark:bg-surface-2">
              <Icon icon={Brain} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Ver la memoria
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Lo que el espacio recuerda y que Loki usa al responder
              </span>
            </span>
            <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
          </CardRow>
        </Card>
      </section>

      {user !== null && currentWorkspaceId !== null ? (
        <AiUsageSection
          wsId={currentWorkspaceId}
          uid={user.uid}
          isAdmin={isSpaceAdmin}
        />
      ) : null}

      <MembersSection />

      <section aria-label="Cuenta">
        <SectionLabel>Cuenta</SectionLabel>
        <Card>
          <button
            type="button"
            aria-label="Cerrar sesion"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 text-left text-body font-medium text-danger outline-none interactive disabled:opacity-60"
          >
            <Icon icon={LogOut} size={22} />
            {signingOut ? "Cerrando..." : "Cerrar sesión"}
          </button>
        </Card>
      </section>
    </div>
  );
}
