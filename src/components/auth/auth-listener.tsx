"use client";

import * as React from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";
import { useSessionStore, type SessionUser } from "@/stores/session-store";

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

  React.useEffect(() => {
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user === null) {
        clear();
      } else {
        setUser(toSessionUser(user));
      }
    });
    return () => unsubscribe();
  }, [setUser, clear]);

  return null;
}
