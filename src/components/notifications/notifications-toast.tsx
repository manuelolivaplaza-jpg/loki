"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_PREFS, isQuietNow } from "@/lib/data/notifications";
import { NOTIFICATION_ICONS } from "@/components/notifications/notifications-bell";
import { useNotificationPrefs, useNotifications } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { Icon } from "@/components/ui/icon";
import type { NotificationItem } from "@/types/organizer";

/** Toast discreto con lo que llega nuevo (respeta tipo y silencio). */
export function NotificationsToast(): React.JSX.Element | null {
  const router = useRouter();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const { items } = useNotifications(uid);
  const prefsQuery = useNotificationPrefs(uid);
  const [visible, setVisible] = React.useState<NotificationItem | null>(null);
  const seenRef = React.useRef<Set<string> | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  React.useEffect(() => {
    if (uid === null || items.length === 0) return;
    if (seenRef.current === null) {
      // Primera carga: todo lo existente ya se vio (no avisa al entrar).
      seenRef.current = new Set(items.map((item) => item.id));
      return;
    }
    const prefs = prefsQuery.data ?? DEFAULT_PREFS;
    const fresh = items.find(
      (item) =>
        !seenRef.current?.has(item.id) &&
        item.readAt === null &&
        prefs[item.type] === true &&
        !isQuietNow(prefs),
    );
    for (const item of items) seenRef.current.add(item.id);
    if (fresh === undefined) return;
    setVisible(fresh);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(null);
    }, 4000);
  }, [uid, items, prefsQuery.data]);

  if (visible === null) return null;
  const icon = NOTIFICATION_ICONS[visible.type];
  const open = (): void => {
    setVisible(null);
    if (visible.link !== "") router.push(visible.link);
    else router.push("/notificaciones");
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-8">
      <button
        type="button"
        onClick={open}
        className="pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-2xl bg-foreground px-4 py-3 text-left text-background shadow-overlay outline-none dark:bg-white dark:text-black"
      >
        <span aria-hidden="true" className="flex shrink-0 items-center">
          <Icon icon={icon} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-sm font-semibold leading-5">
            {visible.title}
          </span>
          {visible.body !== "" ? (
            <span className="block truncate text-body-sm leading-5 opacity-80">
              {visible.body}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
