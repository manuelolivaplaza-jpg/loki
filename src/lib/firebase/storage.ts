import type { FirebaseStorage } from "firebase/storage";
import { getFirebaseApp } from "./app";
import { useEmulators } from "./config";

type EmulatorFlags = {
  __loki_storage_emulator_connected?: boolean;
};

function flags(): EmulatorFlags {
  return globalThis as EmulatorFlags;
}

export async function getStorageLazy(): Promise<FirebaseStorage> {
  if (typeof window === "undefined") {
    throw new Error(
      "Firebase Storage is client-only. Call getStorageLazy() in the browser.",
    );
  }
  const { connectStorageEmulator, getStorage } = await import("firebase/storage");
  const storage = getStorage(getFirebaseApp());
  if (useEmulators && !flags().__loki_storage_emulator_connected) {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    flags().__loki_storage_emulator_connected = true;
  }
  return storage;
}
