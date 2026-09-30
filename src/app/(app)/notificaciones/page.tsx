"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SectionLabel } from "@/components/ui/section-label";
import { QueryRetry } from "@/components/ui/query-retry";
import { NotificationsTray } from "@/components/notifications/notifications-tray";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { NotificationItem } from "@/types/organizer";

export default function NotificacionesPage(): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const { items, isPending, error, retry } = useNotifications(user?.uid ?? null);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  function openItem(item: NotificationItem): void {
    if (item.readAt === null) {
      markRead.mutate(item.id);
    }
    if (item.link !== "") {
      router.push(item.link);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 md:py-8">
      <SectionLabel>Notificaciones</SectionLabel>
      {error !== null && items.length === 0 ? (
        <QueryRetry
          message="No se pudieron cargar las notificaciones."
          onRetry={retry}
        />
      ) : isPending && items.length === 0 ? (
        <div className="flex flex-col gap-2" aria-label="Cargando notificaciones">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="block h-16 animate-pulse rounded-lg bg-surface-soft"
            />
          ))}
        </div>
      ) : (
        <NotificationsTray
          items={items}
          onOpen={openItem}
          onMarkAll={() => {
            if (user !== null) markAll.mutate(user.uid);
          }}
          markingAll={markAll.isPending}
        />
      )}
    </div>
  );
}
