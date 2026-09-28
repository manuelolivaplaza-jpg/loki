import { create } from "zustand";
import type { UserProfile } from "@/types/models";

export type ProfileStatus = "idle" | "loading" | "ready" | "error";

type ProfileState = {
  profile: UserProfile | null;
  profileStatus: ProfileStatus;
  profileError: string | null;
  setProfile: (profile: UserProfile) => void;
  setProfileStatus: (status: ProfileStatus) => void;
  setProfileError: (message: string | null) => void;
  clearProfile: () => void;
};

export const useProfileStore = create<ProfileState>()((set) => ({
  profile: null,
  profileStatus: "idle",
  profileError: null,
  setProfile: (profile) => set({ profile }),
  setProfileStatus: (profileStatus) => set({ profileStatus }),
  setProfileError: (profileError) => set({ profileError }),
  clearProfile: () =>
    set({ profile: null, profileStatus: "idle", profileError: null }),
}));
