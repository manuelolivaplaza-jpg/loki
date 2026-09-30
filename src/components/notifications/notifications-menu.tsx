"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { NOTIFICATION_ICONS } from "@/components/notifications/notifications-bell";
import {
  useMarkNotificationRead,
  useNotifications,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { NotificationItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

/**
 * Campana de la barra lateral (encima del perfil): un clic abre el menú con
 * las últimas notificaciones, doble clic va a la bandeja completa.
 */
export function NotificationsMenu({
  expanded,
}: {
  expanded: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const { items, unread } = useNotifications(uid);
  const markRead = useMarkNotificationRead();
  const [open, setOpen] = React.useState(false);

  const latest = items.slice(0, 6);

  function openItem(item: NotificationItem): void {
    if (item.readAt === null) markRead.mutate(item.id);
    setOpen(false);
    if (item.link !== "") router.push(item.link);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          onDoubleClick={() => router.push("/notificaciones")}
          aria-label={
            unread > 0
              ? `Notificaciones, ${unread} sin leer`
              : "Notificaciones"
          }
          title="Notificaciones (doble clic para ver todas)"
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex h-11 w-full items-center justify-start gap-3 rounded-full px-3 text-foreground outline-none interactive"
        >
          <span className="relative flex items-center justify-center">
            <Icon icon={Bell} size={20} />
            {unread > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-mention px-1 text-[11px] font-semibold leading-4 text-white"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </span>
          {expanded ? (
            <span className="text-body-sm">Notificaciones</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-80 p-0">
        <div
          role="menu"
          aria-label="Últimas notificaciones"
          className="flex max-h-80 flex-col overflow-y-auto py-1"
        >
          {latest.length === 0 ? (
            <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
              Sin notificaciones.
            </p>
          ) : (
            latest.map((item) => {
              const icon = NOTIFICATION_ICONS[item.type];
              const isUnread = item.readAt === null;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => openItem(item)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none interactive"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground"
                  >
                    <Icon icon={icon} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-body-sm leading-5",
                        isUnread
                          ? "font-semibold text-foreground"
                          : "font-medium text-foreground",
                      )}
                    >
                      {item.title}
                    </span>
                    {item.body !== "" ? (
                      <span className="block truncate text-meta leading-4 text-muted-foreground">
                        {item.body}
                      </span>
                    ) : null}
                  </span>
                  {isUnread ? (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full bg-mention"
                    />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-divider p-1">
          <Link
            href="/notificaciones"
            onClick={() => setOpen(false)}
            className="flex h-10 w-full items-center justify-center rounded-sm text-body-sm font-semibold text-mention outline-none interactive"
          >
            Ver todas
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
