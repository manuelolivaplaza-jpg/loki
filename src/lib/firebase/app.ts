import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getFirebaseConfig } from "./config";

export function getFirebaseApp(): FirebaseApp {
  if (typeof window === "undefined") {
    throw new Error("Firebase is client-only. Call getFirebaseApp() in the browser.");
  }
  const existing = getApps();
  if (existing.length > 0 && existing[0] !== undefined) {
    return existing[0];
  }
  return initializeApp(getFirebaseConfig());
}
