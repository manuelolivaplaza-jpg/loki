"use client";

import * as React from "react";
import { Card, CardDivider } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Bell } from "lucide-react";
import { groupNotifications } from "@/lib/data/notifications";
import { NOTIFICATION_ICONS } from "@/components/notifications/notifications-bell";
import type { NotificationItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

const GROUP_TITLES = {
  today: "Hoy",
  yesterday: "Ayer",
  older: "Antes",
} as const;

function TrayRow({
  item,
  onOpen,
}: {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
}): React.JSX.Element {
  const icon = NOTIFICATION_ICONS[item.type];
  const unread = item.readAt === null;
  const body =
    item.link !== "" ? (
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none interactive"
      >
        <RowContent item={item} icon={icon} unread={unread} />
      </button>
    ) : (
      <div className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 py-3">
        <RowContent item={item} icon={icon} unread={unread} />
      </div>
    );
  return body;
}

function RowContent({
  item,
  icon,
  unread,
}: {
  item: NotificationItem;
  icon: typeof Bell;
  unread: boolean;
}): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground"
      >
        <Icon icon={icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-body-sm leading-5",
            unread ? "font-semibold text-foreground" : "font-medium text-foreground",
          )}
        >
          {item.title}
        </span>
        {item.body !== "" ? (
          <span className="block truncate text-body-sm leading-5 text-muted-foreground">
            {item.body}
          </span>
        ) : null}
      </span>
      {unread ? (
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-mention" />
      ) : null}
    </>
  );
}

export function NotificationsTray({
  items,
  onOpen,
  onMarkAll,
  markingAll,
}: {
  items: NotificationItem[];
  onOpen: (item: NotificationItem) => void;
  onMarkAll: () => void;
  markingAll: boolean;
}): React.JSX.Element {
  const groups = React.useMemo(() => groupNotifications(items), [items]);
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title="Sin notificaciones"
        description="Aquí verás menciones, respuestas y recordatorios."
      />
    );
  }
  const anyUnread = items.some((item) => item.readAt === null);
  return (
    <div className="flex flex-col gap-4">
      {anyUnread ? (
        <div className="flex justify-end px-2">
          <button
            type="button"
            onClick={onMarkAll}
            disabled={markingAll}
            className="text-body-sm font-semibold text-mention outline-none [@media(hover:hover)]:underline disabled:opacity-60"
          >
            {markingAll ? "Marcando…" : "Marcar todo como leído"}
          </button>
        </div>
      ) : null}
      {groups.map(({ group, items: rows }) => (
        <section key={group} aria-label={GROUP_TITLES[group]}>
          <p className="px-2 pb-1 text-meta font-medium text-muted-foreground">
            {GROUP_TITLES[group]}
          </p>
          <Card>
            {rows.map((item, index) => (
              <React.Fragment key={item.id}>
                {index > 0 ? <CardDivider /> : null}
                <TrayRow item={item} onOpen={onOpen} />
              </React.Fragment>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
