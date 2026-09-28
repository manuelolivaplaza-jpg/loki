import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { getFirebaseApp } from "./app";
import { useEmulators } from "./config";

type EmulatorFlags = {
  __loki_firebase_auth_emulator_connected?: boolean;
};

function flags(): EmulatorFlags {
  return globalThis as EmulatorFlags;
}

export function getFirebaseAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("Firebase Auth is client-only. Call getFirebaseAuth() in the browser.");
  }
  const auth = getAuth(getFirebaseApp());
  if (useEmulators && !flags().__loki_firebase_auth_emulator_connected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    flags().__loki_firebase_auth_emulator_connected = true;
  }
  return auth;
}
