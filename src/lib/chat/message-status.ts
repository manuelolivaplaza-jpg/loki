"use client";

import { create } from "zustand";
import type { MessageSendStatus } from "@/types/chat";

type MessageStatusState = {
  /** Mapa messageId -> estado local. Solo vive en memoria del cliente. */
  status: Record<string, MessageSendStatus>;
  setStatus: (id: string, value: MessageSendStatus) => void;
  clearStatus: (id: string) => void;
  /**
   * Limpia los estados de ids que el snapshot en vivo ya confirma
   * (el servidor los tiene: el optimista queda reemplazado).
   */
  clearConfirmed: (ids: readonly string[]) => void;
};

export const useMessageStatusStore = create<MessageStatusState>()((set) => ({
  status: {},
  setStatus: (id, value) =>
    set((state) =>
      state.status[id] === value
        ? state
        : { status: { ...state.status, [id]: value } },
    ),
  clearStatus: (id) =>
    set((state) => {
      if (!(id in state.status)) return state;
      const next = { ...state.status };
      delete next[id];
      return { status: next };
    }),
  clearConfirmed: (ids) =>
    set((state) => {
      let changed = false;
      const next = { ...state.status };
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? { status: next } : state;
    }),
}));

/** Estado local de un mensaje (`undefined` = confirmado o ajeno). */
export function useMessageStatus(id: string): MessageSendStatus | undefined {
  return useMessageStatusStore((state) => state.status[id]);
}
