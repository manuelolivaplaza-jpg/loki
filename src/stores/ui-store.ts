import { create } from "zustand";

type UiState = {
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  /** Barra lateral de escritorio: contraída (iconos) o extendida (con nombres). */
  sidebarExpanded: boolean;
  toggleSidebar: () => void;
};

export const useUiStore = create<UiState>()((set) => ({
  rightPanelOpen: true,
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
  toggleRightPanel: () =>
    set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  sidebarExpanded: false,
  toggleSidebar: () =>
    set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
}));
