import { create } from "zustand";

export type SessionUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
};

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

type SessionState = {
  user: SessionUser | null;
  status: SessionStatus;
  setUser: (user: SessionUser) => void;
  clear: () => void;
};

export const useSessionStore = create<SessionState>()((set) => ({
  user: null,
  status: "loading",
  setUser: (user) => set({ user, status: "authenticated" }),
  clear: () => set({ user: null, status: "unauthenticated" }),
}));
