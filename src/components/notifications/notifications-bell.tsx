"use client";

import Link from "next/link";
import {
  AtSign,
  BarChart3,
  Bell,
  Bot,
  Brain,
  CalendarClock,
  ClipboardCheck,
  Heart,
  ListChecks,
  Reply,
  Sparkles,
  Sunrise,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { useNotifications } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { NotificationType } from "@/types/organizer";
import { cn } from "@/lib/utils";

export const NOTIFICATION_ICONS: Record<NotificationType, LucideIcon> = {
  mention: AtSign,
  reply: Reply,
  reaction: Heart,
  task_assigned: ClipboardCheck,
  task_due: ClipboardCheck,
  event_reminder: CalendarClock,
  invite: UserPlus,
  ai_alert: Sparkles,
  list: ListChecks,
  poll: BarChart3,
  memory: Brain,
  daily: Sunrise,
  agent: Bot,
};

/** Campana del header con punto si hay no leídas. */
export function NotificationsBell(): React.JSX.Element {
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const { unread } = useNotifications(uid);
  return (
    <Link
      href="/notificaciones"
      aria-label={unread > 0 ? `Notificaciones, ${unread} sin leer` : "Notificaciones"}
      className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground outline-none interactive"
    >
      <Icon icon={Bell} size={20} />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-2 top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1",
            "bg-mention text-[11px] font-semibold leading-4 text-white",
          )}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
