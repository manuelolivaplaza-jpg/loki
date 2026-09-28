import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

const PROJECT_ID = "demo-loki";
const WS_ID = "ws-t8-test";
const OWNER_UID = "owner-t8";
const STRANGER_UID = "stranger-t8";

function rulesSource() {
  return fs.readFileSync("firestore.rules", "utf8");
}

async function seedUser(env, uid) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", uid), {
      uid,
      email: `${uid}@example.com`,
      displayName: uid === OWNER_UID ? "Owner" : "Stranger",
      avatarColor: "#00b4d8",
      avatarInitial: "O",
      onboardingCompleted: true,
      currentWorkspaceId: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

async function createWorkspaceBatch(ownerDb, wsId) {
  const workspaceRef = doc(ownerDb, "workspaces", wsId);
  const memberRef = doc(ownerDb, "workspaces", wsId, "members", OWNER_UID);
  const membershipRef = doc(ownerDb, "users", OWNER_UID, "memberships", wsId);
  const userRef = doc(ownerDb, "users", OWNER_UID);
  const batch = writeBatch(ownerDb);
  batch.set(workspaceRef, {
    name: "Familia Test",
    emoji: "🏠",
    kind: "family",
    ownerId: OWNER_UID,
    createdAt: serverTimestamp(),
  });
  batch.set(memberRef, {
    uid: OWNER_UID,
    role: "owner",
    displayName: "Owner",
    avatarColor: "#00b4d8",
    joinedAt: serverTimestamp(),
  });
  batch.set(membershipRef, {
    wsId,
    name: "Familia Test",
    emoji: "🏠",
    kind: "family",
    role: "owner",
    joinedAt: serverTimestamp(),
  });
  batch.update(userRef, {
    currentWorkspaceId: wsId,
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
}

describe("firestore.rules T8", () => {
  let testEnv;

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: rulesSource(),
        host: "127.0.0.1",
        port: 8080,
      },
    });
    await testEnv.clearFirestore();
    await seedUser(testEnv, OWNER_UID);
    await seedUser(testEnv, STRANGER_UID);
  });

  after(async () => {
    await testEnv.clearFirestore();
    await testEnv.cleanup();
  });

  it("owner crea espacio (batch) OK", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await createWorkspaceBatch(ownerDb, WS_ID);
    const snap = await assertSucceeds(
      getDoc(doc(ownerDb, "workspaces", WS_ID)),
    );
    assert.equal(snap.exists(), true);
  });

  it("owner lee su espacio OK", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const snap = await assertSucceeds(
      getDoc(doc(ownerDb, "workspaces", WS_ID)),
    );
    assert.equal(snap.exists(), true);
    const memberSnap = await assertSucceeds(
      getDoc(doc(ownerDb, "workspaces", WS_ID, "members", OWNER_UID)),
    );
    assert.equal(memberSnap.exists(), true);
  });

  it("usuario ajeno NO puede leer workspaces/{id} ni members", async () => {
    const strangerDb = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(getDoc(doc(strangerDb, "workspaces", WS_ID)));
    await assertFails(
      getDoc(doc(strangerDb, "workspaces", WS_ID, "members", OWNER_UID)),
    );
    await assertFails(
      getDocs(collection(strangerDb, "workspaces", WS_ID, "members")),
    );
  });

  it("usuario ajeno NO puede crearse como miembro", async () => {
    const strangerDb = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(
      setDoc(
        doc(strangerDb, "workspaces", WS_ID, "members", STRANGER_UID),
        {
          uid: STRANGER_UID,
          role: "member",
          displayName: "Stranger",
          avatarColor: "#00b4d8",
          joinedAt: serverTimestamp(),
        },
      ),
    );
    await assertFails(
      setDoc(
        doc(strangerDb, "workspaces", WS_ID, "members", STRANGER_UID),
        {
          uid: STRANGER_UID,
          role: "owner",
          displayName: "Stranger",
          avatarColor: "#00b4d8",
          joinedAt: serverTimestamp(),
        },
      ),
    );
  });

  it("usuario no autenticado no lee nada", async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, "workspaces", WS_ID)));
    await assertFails(getDoc(doc(anonDb, "users", OWNER_UID)));
    await assertFails(
      getDocs(collection(anonDb, "users", OWNER_UID, "memberships")),
    );
  });

  it("usuario lee sus memberships pero no las de otro", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    const strangerDb = testEnv.authenticatedContext(STRANGER_UID).firestore();
    const ownList = await assertSucceeds(
      getDocs(collection(ownerDb, "users", OWNER_UID, "memberships")),
    );
    assert.ok(ownList.size >= 1);
    await assertFails(
      getDocs(collection(strangerDb, "users", OWNER_UID, "memberships")),
    );
    await assertFails(getDoc(doc(strangerDb, "users", OWNER_UID)));
  });

  it("update del nombre por owner OK y cambio de ownerId denegado", async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(ownerDb, "workspaces", WS_ID), {
        name: "Familia Test v2",
      }),
    );
    const snap = await assertSucceeds(
      getDoc(doc(ownerDb, "workspaces", WS_ID)),
    );
    assert.equal(snap.data()?.name, "Familia Test v2");
    await assertFails(
      updateDoc(doc(ownerDb, "workspaces", WS_ID), {
        ownerId: STRANGER_UID,
      }),
    );
  });
});
