"use client";

import * as React from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore, type SessionUser } from "@/stores/session-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

function toSessionUser(user: User): SessionUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

export function AuthListener(): React.JSX.Element | null {
  const setUser = useSessionStore((state) => state.setUser);
  const clear = useSessionStore((state) => state.clear);
  const clearProfile = useProfileStore((state) => state.clearProfile);
  const clearWorkspaces = useWorkspaceStore((state) => state.clearWorkspaces);

  React.useEffect(() => {
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user === null) {
        clear();
        clearProfile();
        clearWorkspaces();
      } else {
        setUser(toSessionUser(user));
      }
    });
    return () => unsubscribe();
  }, [setUser, clear, clearProfile, clearWorkspaces]);

  return null;
}
