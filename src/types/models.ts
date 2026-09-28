import type { Timestamp } from "firebase/firestore";

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  avatarInitial: string;
  avatarColor: string;
  createdAt: Timestamp;
  onboardingCompleted: boolean;
}

export type WorkspaceKind = "family" | "team";

export interface Workspace {
  id: string;
  name: string;
  emoji: string;
  kind: WorkspaceKind;
  ownerId: string;
  createdAt: Timestamp;
  memberCount?: number;
}

export type MemberRole = "owner" | "admin" | "member";

export interface Member {
  uid: string;
  role: MemberRole;
  displayName: string;
  joinedAt: Timestamp;
}
