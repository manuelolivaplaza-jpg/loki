"use client";

import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type UpdateData,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase/firestore";
import type { SessionUser } from "@/stores/session-store";
import {
  DEFAULT_AVATAR_COLOR,
  getAvatarInitial,
  type UserProfile,
} from "@/types/models";

export type UpdateUserProfilePatch = {
  displayName?: string;
  avatarColor?: string;
  avatarInitial?: string;
  onboardingCompleted?: boolean;
  currentWorkspaceId?: string | null;
};

export async function getUserProfile(
  uid: string,
): Promise<UserProfile | null> {
  const snapshot = await getDoc(doc(getDb(), "users", uid));
  if (!snapshot.exists()) {
    return null;
  }
  return snapshot.data() as UserProfile;
}

/** Carga el perfil y lo crea con valores base (onboarding pendiente) si no existe. */
export async function ensureUserProfile(
  user: SessionUser,
): Promise<UserProfile> {
  const db = getDb();
  const ref = doc(db, "users", user.uid);
  const snapshot = await getDoc(ref);
  if (snapshot.exists()) {
    return snapshot.data() as UserProfile;
  }
  const displayName = (user.displayName ?? "").trim();
  const email = user.email ?? "";
  await setDoc(ref, {
    uid: user.uid,
    email,
    displayName,
    avatarColor: DEFAULT_AVATAR_COLOR,
    avatarInitial: getAvatarInitial(displayName, email),
    onboardingCompleted: false,
    currentWorkspaceId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const created = await getDoc(ref);
  if (!created.exists()) {
    throw new Error("No se pudo crear tu perfil. Inténtalo de nuevo.");
  }
  return created.data() as UserProfile;
}

export async function updateUserProfile(
  uid: string,
  patch: UpdateUserProfilePatch,
): Promise<void> {
  const data: UpdateData<DocumentData> = { updatedAt: serverTimestamp() };
  if (patch.displayName !== undefined) {
    data.displayName = patch.displayName;
  }
  if (patch.avatarColor !== undefined) {
    data.avatarColor = patch.avatarColor;
  }
  if (patch.avatarInitial !== undefined) {
    data.avatarInitial = patch.avatarInitial;
  }
  if (patch.onboardingCompleted !== undefined) {
    data.onboardingCompleted = patch.onboardingCompleted;
  }
  if (patch.currentWorkspaceId !== undefined) {
    data.currentWorkspaceId = patch.currentWorkspaceId;
  }
  await updateDoc(doc(getDb(), "users", uid), data);
}
