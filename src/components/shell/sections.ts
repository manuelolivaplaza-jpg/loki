import {
  CalendarDays,
  FolderKanban,
  House,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { normalizePathname } from "@/lib/navigation";

export type SectionKey = "inicio" | "chat" | "calendario" | "proyectos";

export type ContextItem = {
  title: string;
  meta: string;
};

export type SectionMeta = {
  key: SectionKey;
  href: string;
  label: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  contextTitle: string;
  contextItems: ContextItem[];
};

export const NAV_ITEMS: SectionMeta[] = [
  {
    key: "inicio",
    href: "/inicio",
    label: "Inicio",
    icon: House,
    emptyTitle: "Sin actividad todavía",
    emptyDescription: "Tu resumen aparecerá aquí.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Resumen", meta: "Tu día de un vistazo" },
      { title: "Pendientes", meta: "0 tareas abiertas" },
      { title: "Próximo evento", meta: "Nada programado" },
    ],
  },
  {
    key: "chat",
    href: "/chat",
    label: "Chat",
    icon: MessageCircle,
    emptyTitle: "Sin conversaciones todavía",
    emptyDescription: "Inicia un chat nuevo para empezar.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Hilos fijados", meta: "1 fijado" },
      { title: "Actividad reciente", meta: "Sin actividad hoy" },
      { title: "Atajos", meta: "Nuevo chat con N" },
    ],
  },
  {
    key: "calendario",
    href: "/calendario",
    label: "Calendario",
    icon: CalendarDays,
    emptyTitle: "Sin eventos próximos",
    emptyDescription: "No tienes nada programado por ahora.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Hoy", meta: "0 eventos" },
      { title: "Esta semana", meta: "0 eventos" },
      { title: "Recordatorios", meta: "Ninguno activo" },
    ],
  },
  {
    key: "proyectos",
    href: "/proyectos",
    label: "Proyectos",
    icon: FolderKanban,
    emptyTitle: "Sin proyectos",
    emptyDescription: "Crea tu primer proyecto para organizarte.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Activos", meta: "0 proyectos" },
      { title: "Archivados", meta: "0 proyectos" },
      { title: "Tareas abiertas", meta: "0 tareas" },
    ],
  },
];

export const SECTIONS: Record<SectionKey, SectionMeta> = {
  inicio: NAV_ITEMS[0] as SectionMeta,
  chat: NAV_ITEMS[1] as SectionMeta,
  calendario: NAV_ITEMS[2] as SectionMeta,
  proyectos: NAV_ITEMS[3] as SectionMeta,
};

export function getSectionByPath(pathname: string | null): SectionMeta {
  const normalized = normalizePathname(pathname);
  if (!normalized) return SECTIONS.inicio;
  const found = NAV_ITEMS.find(
    (item) => normalized === item.href || normalized.startsWith(`${item.href}/`),
  );
  // Rutas heredadas: el feed vive dentro del chat e ideas dentro de proyectos.
  if (normalized === "/feed" || normalized.startsWith("/feed/")) {
    return SECTIONS.chat;
  }
  if (normalized === "/ideas" || normalized.startsWith("/ideas/")) {
    return SECTIONS.proyectos;
  }
  return found ?? SECTIONS.inicio;
}

/**
 * Rutas de pantalla completa en móvil: sin barra inferior ni padding extra
 * (conversación de chat, perfil y configuración).
 * `/chat/publicaciones` es una lista (no una conversación) y conserva la barra.
 */
export function isFullscreenRoute(pathname: string | null): boolean {
  const normalized = normalizePathname(pathname);
  if (!normalized) return false;
  if (normalized === "/perfil" || normalized.startsWith("/perfil/")) return true;
  if (normalized === "/configuracion" || normalized.startsWith("/configuracion/")) {
    return true;
  }
  if (normalized === "/chat/publicaciones") return false;
  if (normalized === "/chat/c" || normalized.startsWith("/chat/c/")) return true;
  if (normalized === "/chat/loki-ia" || normalized.startsWith("/chat/loki-ia/")) {
    return true;
  }
  if (normalized.startsWith("/chat/") && normalized !== "/chat/") return true;
  // La búsqueda completa es una pantalla con su propia cabecera (con atrás):
  // sin barra inferior.
  if (normalized === "/buscar") return true;
  return false;
}
