import type { Timestamp } from "firebase/firestore";

export interface AvatarColorOption {
  name: string;
  value: string;
}

/**
 * Paleta sobria de avatar derivada de los tokens del tema
 * (accent, mention, success, warning, danger + violeta sobrio + gris).
 */
export const AVATAR_COLORS: readonly AvatarColorOption[] = [
  { name: "Celeste", value: "#00b4d8" },
  { name: "Azul", value: "#1d9bf0" },
  { name: "Verde", value: "#00ba7c" },
  { name: "Ámbar", value: "#ffad1f" },
  { name: "Rojo", value: "#f4212e" },
  { name: "Violeta", value: "#6d5fc0" },
  { name: "Gris", value: "#536471" },
];

export const DEFAULT_AVATAR_COLOR: string =
  AVATAR_COLORS[0]?.value ?? "#00b4d8";

/**
 * Color neutro de respaldo cuando no hay avatar (gris de la paleta).
 * Vivir aquí evita hex sueltos en los TSX: las pantallas importan la constante.
 */
export const AVATAR_FALLBACK_COLOR: string = "#536471";

export function isAvatarColor(value: string): boolean {
  return AVATAR_COLORS.some((option) => option.value === value);
}

export function getAvatarInitial(
  displayName: string | null | undefined,
  email?: string | null | undefined,
): string {
  const name = (displayName ?? "").trim();
  if (name !== "") {
    return name.charAt(0).toUpperCase();
  }
  const mail = (email ?? "").trim();
  if (mail !== "") {
    return mail.charAt(0).toUpperCase();
  }
  return "L";
}

/** Color de texto legible sobre el fondo del avatar. */
export function avatarTextColor(background: string): string {
  return background.toLowerCase() === "#ffad1f" ? "#0f1419" : "#ffffff";
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string;
  avatarColor: string;
  avatarInitial: string;
  onboardingCompleted: boolean;
  currentWorkspaceId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type WorkspaceKind = "family" | "team";

export interface WorkspaceDoc {
  name: string;
  emoji: string;
  kind: WorkspaceKind;
  ownerId: string;
  createdAt: Timestamp;
}

export type MemberRole = "owner" | "admin" | "member";

export interface WorkspaceMember {
  uid: string;
  role: MemberRole;
  displayName: string;
  avatarColor: string;
  joinedAt: Timestamp;
}

/** Índice espejo en users/{uid}/memberships para listar espacios sin collection group. */
export interface WorkspaceMembership {
  wsId: string;
  name: string;
  emoji: string;
  kind: WorkspaceKind;
  role: MemberRole;
  joinedAt: Timestamp;
}

// Compatibilidad con el modelo de T6.
export type User = UserProfile;
export type Workspace = WorkspaceDoc & { id: string; memberCount?: number };
export type Member = WorkspaceMember;
