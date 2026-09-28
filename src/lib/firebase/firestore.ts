import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { getFirebaseApp } from "./app";
import { useEmulators } from "./config";

type EmulatorFlags = {
  __loki_firestore_emulator_connected?: boolean;
};

function flags(): EmulatorFlags {
  return globalThis as EmulatorFlags;
}

export function getDb(): Firestore {
  if (typeof window === "undefined") {
    throw new Error("Firestore is client-only. Call getDb() in the browser.");
  }
  const db = getFirestore(getFirebaseApp());
  if (useEmulators && !flags().__loki_firestore_emulator_connected) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    flags().__loki_firestore_emulator_connected = true;
  }
  return db;
}
