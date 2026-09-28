"use client";

import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase/firestore";
import type { WorkspaceKind, WorkspaceMembership } from "@/types/models";

export type CreateWorkspaceInput = {
  name: string;
  emoji: string;
  kind: WorkspaceKind;
};

export type WorkspaceActor = {
  uid: string;
  displayName: string;
  avatarColor: string;
};

/**
 * Crea el espacio, el miembro owner y el índice espejo en memberships,
 * y deja el espacio como actual del usuario. Todo en un solo batch.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  actor: WorkspaceActor,
): Promise<string> {
  const name = input.name.trim();
  if (name === "") {
    throw new Error("Ponle un nombre a tu espacio.");
  }
  const displayName =
    actor.displayName.trim() === "" ? "Miembro" : actor.displayName.trim();
  const db = getDb();
  const workspaceRef = doc(collection(db, "workspaces"));
  const wsId = workspaceRef.id;
  const batch = writeBatch(db);
  batch.set(workspaceRef, {
    name,
    emoji: input.emoji,
    kind: input.kind,
    ownerId: actor.uid,
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "workspaces", wsId, "members", actor.uid), {
    uid: actor.uid,
    role: "owner",
    displayName,
    avatarColor: actor.avatarColor,
    joinedAt: serverTimestamp(),
  });
  batch.set(doc(db, "users", actor.uid, "memberships", wsId), {
    wsId,
    name,
    emoji: input.emoji,
    kind: input.kind,
    role: "owner",
    joinedAt: serverTimestamp(),
  });
  batch.update(doc(db, "users", actor.uid), {
    currentWorkspaceId: wsId,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
  return wsId;
}

/** Lista los espacios del usuario desde su índice espejo en memberships. */
export async function listMyWorkspaces(
  uid: string,
): Promise<WorkspaceMembership[]> {
  const snapshot = await getDocs(
    collection(getDb(), "users", uid, "memberships"),
  );
  return snapshot.docs.map((item) => item.data() as WorkspaceMembership);
}
