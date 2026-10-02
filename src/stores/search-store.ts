"use client";

import { create } from "zustand";

export type PendingLokiQuestion = {
  id: string;
  text: string;
};

type SearchStoreState = {
  /** Paleta de búsqueda abierta (Cmd/Ctrl+K, lupa móvil o lupa desktop). */
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Pregunta pendiente de la búsqueda ("Preguntar a Loki"): la consume el
   * chat de Loki UNA vez al abrirse y la envía como mensaje propio.
   */
  lokiQuestion: PendingLokiQuestion | null;
  setLokiQuestion: (question: PendingLokiQuestion | null) => void;
};

export const useSearchStore = create<SearchStoreState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  lokiQuestion: null,
  setLokiQuestion: (lokiQuestion) => set({ lokiQuestion }),
}));
