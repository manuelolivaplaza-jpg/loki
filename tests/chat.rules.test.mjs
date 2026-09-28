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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

const PROJECT_ID = "demo-loki";
const WS_ID = "ws-c12-main";
const WS_BATCH = "ws-c12-batch";
const OWNER_UID = "owner-c12";
const MEMBER_UID = "member-c12";
const STRANGER_UID = "stranger-c12";

function rulesSource() {
  return fs.readFileSync("firestore.rules", "utf8");
}

function userPayload(uid, displayName) {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName,
    avatarColor: "#00b4d8",
    avatarInitial: displayName.charAt(0),
    onboardingCompleted: true,
    currentWorkspaceId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function chatPayload(overrides = {}) {
  return {
    type: "group",
    name: "General",
    memberIds: [],
    createdBy: OWNER_UID,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastMessage: null,
    ...overrides,
  };
}

function messagePayload(overrides = {}) {
  return {
    authorId: MEMBER_UID,
    authorName: "Member",
    text: "hola",
    mentions: [],
    replyTo: null,
    threadParentId: null,
    threadCount: 0,
    lastReplyAt: null,
    attachments: [],
    reactions: {},
    lastReaction: null,
    createdAt: serverTimestamp(),
    editedAt: null,
    deleted: false,
    type: "user",
    ...overrides,
  };
}

async function seedAll(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", OWNER_UID), userPayload(OWNER_UID, "Owner"));
    await setDoc(doc(db, "users", MEMBER_UID), userPayload(MEMBER_UID, "Member"));
    await setDoc(
      doc(db, "users", STRANGER_UID),
      userPayload(STRANGER_UID, "Stranger"),
    );
    await setDoc(doc(db, "workspaces", WS_ID), {
      name: "Espacio Chat",
      emoji: "🏠",
      kind: "family",
      ownerId: OWNER_UID,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "workspaces", WS_ID, "members", OWNER_UID), {
      uid: OWNER_UID,
      role: "owner",
      displayName: "Owner",
      avatarColor: "#00b4d8",
      joinedAt: serverTimestamp(),
    });
    await setDoc(doc(db, "workspaces", WS_ID, "members", MEMBER_UID), {
      uid: MEMBER_UID,
      role: "member",
      displayName: "Member",
      avatarColor: "#00ba7c",
      joinedAt: serverTimestamp(),
    });
    await setDoc(
      doc(db, "workspaces", WS_ID, "chats", "general"),
      chatPayload(),
    );
    await setDoc(
      doc(db, "workspaces", WS_ID, "chats", "dm-1"),
      chatPayload({
        type: "dm",
        name: "Owner y Member",
        memberIds: [OWNER_UID, MEMBER_UID],
      }),
    );
    const messages = {
      "m-1": messagePayload(),
      "m-parent": messagePayload({ text: "padre" }),
      "m-parent-2": messagePayload({ text: "padre 2" }),
      "m-react": messagePayload({ text: "reacciona" }),
      "m-react-2": messagePayload({ text: "reacciona 2" }),
      "m-react-seeded": messagePayload({
        text: "con reaccion",
        reactions: { "👍": [MEMBER_UID] },
        lastReaction: { uid: MEMBER_UID, emoji: "👍" },
      }),
    };
    for (const [mid, payload] of Object.entries(messages)) {
      await setDoc(doc(db, "workspaces", WS_ID, "chats", "general", "messages", mid), payload);
    }
    await setDoc(doc(db, "users", OWNER_UID, "aiChats", "main"), {
      title: "Loki IA",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await setDoc(
      doc(db, "users", OWNER_UID, "aiChats", "main", "messages", "ai-m1"),
      messagePayload({ authorId: OWNER_UID, authorName: "Owner", type: "user" }),
    );
  });
}

describe("firestore.rules T12 chat", () => {
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
    await seedAll(testEnv);
  });

  after(async () => {
    await testEnv.clearFirestore();
    await testEnv.cleanup();
  });

  function memberDb() {
    return testEnv.authenticatedContext(MEMBER_UID).firestore();
  }

  function ownerDb() {
    return testEnv.authenticatedContext(OWNER_UID).firestore();
  }

  function strangerDb() {
    return testEnv.authenticatedContext(STRANGER_UID).firestore();
  }

  it("miembro lee chat group y mensajes OK", async () => {
    const db = memberDb();
    const chatSnap = await assertSucceeds(
      getDoc(doc(db, "workspaces", WS_ID, "chats", "general")),
    );
    assert.equal(chatSnap.exists(), true);
    const msgSnap = await assertSucceeds(
      getDoc(doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-1")),
    );
    assert.equal(msgSnap.exists(), true);
    const list = await assertSucceeds(
      getDocs(collection(db, "workspaces", WS_ID, "chats", "general", "messages")),
    );
    assert.ok(list.size >= 1);
  });

  it("no miembro recibe denegado en chat y mensajes", async () => {
    const db = strangerDb();
    await assertFails(getDoc(doc(db, "workspaces", WS_ID, "chats", "general")));
    await assertFails(
      getDoc(doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-1")),
    );
    await assertFails(
      getDocs(collection(db, "workspaces", WS_ID, "chats", "general", "messages")),
    );
  });

  it("dm solo visible para memberIds", async () => {
    const memberSnap = await assertSucceeds(
      getDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "dm-1")),
    );
    assert.equal(memberSnap.exists(), true);
    await assertFails(
      getDoc(doc(strangerDb(), "workspaces", WS_ID, "chats", "dm-1")),
    );
  });

  it("miembro crea mensaje user OK", async () => {
    const db = memberDb();
    await assertSucceeds(
      setDoc(
        doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-new-ok"),
        messagePayload({ text: "nuevo" }),
      ),
    );
  });

  it("crear mensaje con authorId ajeno denegado", async () => {
    const db = memberDb();
    await assertFails(
      setDoc(
        doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-foreign-author"),
        messagePayload({ authorId: OWNER_UID, text: "suplantado" }),
      ),
    );
  });

  it("crear mensaje type 'ai' desde cliente denegado", async () => {
    const db = memberDb();
    await assertFails(
      setDoc(
        doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-ai"),
        messagePayload({ type: "ai", text: "soy ia" }),
      ),
    );
  });

  it("autor edita su texto OK y otro miembro no", async () => {
    await assertSucceeds(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-1"),
        { text: "editado por autor", editedAt: serverTimestamp() },
      ),
    );
    await assertFails(
      updateDoc(
        doc(ownerDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-1"),
        { text: "editado por otro", editedAt: serverTimestamp() },
      ),
    );
  });

  it("otro miembro no puede borrar; el autor si", async () => {
    const db = memberDb();
    await assertSucceeds(
      setDoc(
        doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-mine"),
        messagePayload({ text: "mio" }),
      ),
    );
    await assertFails(
      deleteDoc(doc(ownerDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-mine")),
    );
    await assertSucceeds(
      deleteDoc(doc(db, "workspaces", WS_ID, "chats", "general", "messages", "m-mine")),
    );
  });

  it("reaccion agregando su uid OK", async () => {
    await assertSucceeds(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-react"),
        {
          reactions: { "👍": [MEMBER_UID] },
          lastReaction: { uid: MEMBER_UID, emoji: "👍" },
        },
      ),
    );
  });

  it("reaccion agregando uid ajeno denegada", async () => {
    await assertFails(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-react-2"),
        {
          reactions: { "👍": [OWNER_UID] },
          lastReaction: { uid: MEMBER_UID, emoji: "👍" },
        },
      ),
    );
  });

  it("quitar su propia reaccion OK", async () => {
    await assertSucceeds(
      updateDoc(
        doc(
          memberDb(),
          "workspaces",
          WS_ID,
          "chats",
          "general",
          "messages",
          "m-react-seeded",
        ),
        {
          reactions: { "👍": [] },
          lastReaction: { uid: MEMBER_UID, emoji: "👍" },
        },
      ),
    );
  });

  it("incremento de threadCount +1 OK y +2 denegado", async () => {
    await assertSucceeds(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-parent"),
        { threadCount: 1, lastReplyAt: serverTimestamp() },
      ),
    );
    await assertFails(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "messages", "m-parent-2"),
        { threadCount: 2, lastReplyAt: serverTimestamp() },
      ),
    );
  });

  it("aiChats de otro usuario denegado; propio OK", async () => {
    const ownSnap = await assertSucceeds(
      getDoc(doc(ownerDb(), "users", OWNER_UID, "aiChats", "main")),
    );
    assert.equal(ownSnap.exists(), true);
    await assertFails(
      getDoc(doc(strangerDb(), "users", OWNER_UID, "aiChats", "main")),
    );
    await assertFails(
      getDoc(
        doc(strangerDb(), "users", OWNER_UID, "aiChats", "main", "messages", "ai-m1"),
      ),
    );
    await assertFails(
      getDocs(collection(strangerDb(), "users", OWNER_UID, "aiChats", "main", "messages")),
    );
  });

  it("miembro lista chats con query A (type in [group,posts]) OK", async () => {
    const db = memberDb();
    const q = query(
      collection(db, "workspaces", WS_ID, "chats"),
      where("type", "in", ["group", "posts"]),
      orderBy("updatedAt", "desc"),
    );
    const snap = await assertSucceeds(getDocs(q));
    assert.ok(snap.size >= 1);
  });

  it("miembro lista chats con query B (memberIds array-contains su uid) OK", async () => {
    const db = memberDb();
    const q = query(
      collection(db, "workspaces", WS_ID, "chats"),
      where("memberIds", "array-contains", MEMBER_UID),
      orderBy("updatedAt", "desc"),
    );
    const snap = await assertSucceeds(getDocs(q));
    assert.ok(snap.size >= 1);
  });

  it("no miembro con query A denegada", async () => {
    const db = strangerDb();
    const q = query(
      collection(db, "workspaces", WS_ID, "chats"),
      where("type", "in", ["group", "posts"]),
      orderBy("updatedAt", "desc"),
    );
    await assertFails(getDocs(q));
  });

  it("query sin filtros denegada para miembro cuando existe un dm ajeno (por eso se usan A y B)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(
        doc(db, "workspaces", WS_ID, "chats", "dm-ajeno"),
        chatPayload({
          type: "dm",
          name: "Ajeno",
          memberIds: [OWNER_UID],
          createdBy: OWNER_UID,
        }),
      );
    });
    const db = memberDb();
    await assertFails(
      getDocs(
        query(collection(db, "workspaces", WS_ID, "chats"), orderBy("updatedAt", "desc")),
      ),
    );
  });

  it("miembro lista mensajes del timeline con where threadParentId==null + orderBy + limit OK", async () => {
    const db = memberDb();
    const q = query(
      collection(db, "workspaces", WS_ID, "chats", "general", "messages"),
      where("threadParentId", "==", null),
      orderBy("createdAt", "desc"),
      limit(30),
    );
    const snap = await assertSucceeds(getDocs(q));
    assert.ok(snap.size >= 1);
  });

  it("T14 typing: miembro escribe su marca OK y la ajena denegada", async () => {
    await assertSucceeds(
      setDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", MEMBER_UID),
        { displayName: "Member", updatedAt: serverTimestamp() },
      ),
    );
    await assertFails(
      setDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", OWNER_UID),
        { displayName: "Member", updatedAt: serverTimestamp() },
      ),
    );
  });

  it("T14 typing: otro miembro con acceso lee marcas OK; extraño denegado", async () => {
    await assertSucceeds(
      setDoc(
        doc(ownerDb(), "workspaces", WS_ID, "chats", "general", "typing", OWNER_UID),
        { displayName: "Owner", updatedAt: serverTimestamp() },
      ),
    );
    const memberSnap = await assertSucceeds(
      getDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", OWNER_UID)),
    );
    assert.equal(memberSnap.exists(), true);
    const memberList = await assertSucceeds(
      getDocs(collection(memberDb(), "workspaces", WS_ID, "chats", "general", "typing")),
    );
    assert.ok(memberList.size >= 1);
    await assertFails(
      getDoc(doc(strangerDb(), "workspaces", WS_ID, "chats", "general", "typing", OWNER_UID)),
    );
    await assertFails(
      getDocs(collection(strangerDb(), "workspaces", WS_ID, "chats", "general", "typing")),
    );
  });

  it("T14 typing: displayName vacío denegado; borrado propio OK y ajeno no", async () => {
    await assertFails(
      setDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", MEMBER_UID),
        { displayName: "", updatedAt: serverTimestamp() },
      ),
    );
    await assertSucceeds(
      deleteDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", MEMBER_UID)),
    );
    await assertFails(
      deleteDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "general", "typing", OWNER_UID)),
    );
  });

  it("T14 reads: miembro escribe su marca OK y la ajena denegada", async () => {
    await assertSucceeds(
      setDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "reads", MEMBER_UID),
        { lastReadAt: serverTimestamp(), lastReadMessageId: "m-1" },
      ),
    );
    await assertSucceeds(
      updateDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "reads", MEMBER_UID),
        { lastReadAt: serverTimestamp(), lastReadMessageId: "m-parent" },
      ),
    );
    await assertFails(
      setDoc(
        doc(memberDb(), "workspaces", WS_ID, "chats", "general", "reads", OWNER_UID),
        { lastReadAt: serverTimestamp(), lastReadMessageId: "m-1" },
      ),
    );
  });

  it("T14 reads: otro miembro con acceso lee marcas OK; extraño denegado", async () => {
    const ownerSnap = await assertSucceeds(
      getDoc(doc(ownerDb(), "workspaces", WS_ID, "chats", "general", "reads", MEMBER_UID)),
    );
    assert.equal(ownerSnap.exists(), true);
    const ownerList = await assertSucceeds(
      getDocs(collection(ownerDb(), "workspaces", WS_ID, "chats", "general", "reads")),
    );
    assert.ok(ownerList.size >= 1);
    await assertFails(
      getDoc(doc(strangerDb(), "workspaces", WS_ID, "chats", "general", "reads", MEMBER_UID)),
    );
    await assertFails(
      getDocs(collection(strangerDb(), "workspaces", WS_ID, "chats", "general", "reads")),
    );
  });

  it("T14 reads: borrado propio OK y ajeno denegado", async () => {
    await assertSucceeds(
      setDoc(
        doc(ownerDb(), "workspaces", WS_ID, "chats", "general", "reads", OWNER_UID),
        { lastReadAt: serverTimestamp(), lastReadMessageId: "m-1" },
      ),
    );
    await assertFails(
      deleteDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "general", "reads", OWNER_UID)),
    );
    await assertSucceeds(
      deleteDoc(doc(memberDb(), "workspaces", WS_ID, "chats", "general", "reads", MEMBER_UID)),
    );
  });

  it("creacion de workspace + member + chat general en un mismo batch OK", async () => {
    const db = ownerDb();
    const batch = writeBatch(db);
    batch.set(doc(db, "workspaces", WS_BATCH), {
      name: "Nuevo espacio",
      emoji: "🏠",
      kind: "family",
      ownerId: OWNER_UID,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(db, "workspaces", WS_BATCH, "members", OWNER_UID), {
      uid: OWNER_UID,
      role: "owner",
      displayName: "Owner",
      avatarColor: "#00b4d8",
      joinedAt: serverTimestamp(),
    });
    batch.set(doc(db, "users", OWNER_UID, "memberships", WS_BATCH), {
      wsId: WS_BATCH,
      name: "Nuevo espacio",
      emoji: "🏠",
      kind: "family",
      role: "owner",
      joinedAt: serverTimestamp(),
    });
    batch.update(doc(db, "users", OWNER_UID), {
      currentWorkspaceId: WS_BATCH,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, "workspaces", WS_BATCH, "chats", "general"), {
      type: "group",
      name: "General",
      emoji: "💬",
      memberIds: [],
      createdBy: OWNER_UID,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastMessage: null,
    });
    await assertSucceeds(batch.commit());
    const chatSnap = await assertSucceeds(
      getDoc(doc(db, "workspaces", WS_BATCH, "chats", "general")),
    );
    assert.equal(chatSnap.exists(), true);
  });
});
