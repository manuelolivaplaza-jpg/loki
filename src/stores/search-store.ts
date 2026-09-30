"use client";

import { create } from "zustand";

type SearchStoreState = {
  /** Paleta de búsqueda abierta (Cmd/Ctrl+K, lupa móvil o lupa desktop). */
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const useSearchStore = create<SearchStoreState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
