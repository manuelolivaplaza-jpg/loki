/**
 * RLS de Storage: los buckets `attachments` (privado, con la ruta
 * {workspace_id}/{chat_id}/...) y `avatars` (lectura publica, escritura solo en
 * {uid}/).
 *
 * En Storage una escritura denegada devuelve error (a diferencia de las
 * tablas, donde UPDATE/DELETE sobre filas invisibles Affected 0).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  anonClient,
  assertAllowed,
  assertDenied,
  createTestUser,
  createWorkspaceWith,
  localEnv,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

/** Un PNG minimo valido, para que el storage no lo rechace por contenido. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function pngBlob() {
  return new Blob([PNG_BYTES], { type: "image/png" });
}

describe("RLS: Storage (attachments y avatars)", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  /** Espacio compartido: owner y member son miembros. */
  let sharedWs;
  /** Espacio privado del owner: member NO es miembro. */
  let ownerOnlyWs;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("st-owner", "Owner");
    member = await createTestUser("st-member", "Member");
    stranger = await createTestUser("st-stranger", "Stranger");

    sharedWs = await createWorkspaceWith(owner.client, workspaceName("Adjuntos"));
    await addMember(admin, sharedWs, member.id, "member", "Member");

    ownerOnlyWs = await createWorkspaceWith(owner.client, workspaceName("Privado"));
  });

  after(async () => {
    await purgeTestData();
  });

  it("los buckets attachments (privado) y avatars (publico) existen", async () => {
    // El cliente de supabase-js no expone listar buckets, asi que se va al API
    // de Storage con la service role (que es la que puede ver los metadatos).
    const { url, serviceKey } = localEnv();
    const response = await fetch(`${url}/storage/v1/bucket`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    assert.equal(response.status, 200, "el API de Storage debe listar los buckets");
    const buckets = await response.json();

    const attachments = buckets.find((bucket) => bucket.name === "attachments");
    const avatars = buckets.find((bucket) => bucket.name === "avatars");
    assert.ok(attachments, "falta el bucket attachments");
    assert.equal(attachments.public, false, "attachments debe ser privado");
    assert.ok(avatars, "falta el bucket avatars");
    assert.equal(avatars.public, true, "avatars debe ser publico");
  });

  it("un miembro sube y descarga un adjunto en su espacio", async () => {
    const path = `${sharedWs}/general/hola.png`;
    const upload = await member.client.storage
      .from("attachments")
      .upload(path, pngBlob(), { contentType: "image/png" });
    assertAllowed({ error: upload.error }, "subir un adjunto a mi espacio");

    // El compañero con acceso al espacio tambien lo baja.
    const download = await owner.client.storage.from("attachments").download(path);
    assert.equal(download.error, null, "el owner descarga el adjunto del espacio");
    assert.ok((await download.data.arrayBuffer()).byteLength > 0);
  });

  it("un miembro no sube a un espacio del que no es miembro", async () => {
    const { error } = await member.client.storage
      .from("attachments")
      .upload(`${ownerOnlyWs}/general/intruso.png`, pngBlob(), { contentType: "image/png" });
    assertDenied({ error }, "subir a un espacio ajeno");
  });

  it("un no miembro no sube ni lee adjuntos de un espacio ajeno", async () => {
    const path = `${sharedWs}/general/privado.png`;
    await owner.client.storage
      .from("attachments")
      .upload(path, pngBlob(), { contentType: "image/png" });

    const upload = await stranger.client.storage
      .from("attachments")
      .upload(`${sharedWs}/general/colado.png`, pngBlob(), { contentType: "image/png" });
    assertDenied({ error: upload }, "subir como no miembro");

    const download = await stranger.client.storage.from("attachments").download(path);
    assertDenied({ error: download.error }, "descargar un adjunto de un espacio ajeno");

    // Listar no da error: la RLS de SELECT de storage simply filtra, igual que
    // en las tablas. Se comprueba que no ve ningun objeto.
    const list = await stranger.client.storage
      .from("attachments")
      .list(`${sharedWs}/general`);
    assert.equal(list.error, null);
    assert.equal((list.data ?? []).length, 0, "no debe listar objetos ajenos");
  });

  it("attachments es privado: sin sesion no se leen los objetos", async () => {
    const path = `${sharedWs}/general/hola.png`;
    const anon = anonClient();
    const download = await anon.storage.from("attachments").download(path);
    assertDenied({ error: download.error }, "descargar sin sesion");
  });

  it("avatars: cada uno sube a su carpeta y la lectura es publica", async () => {
    const ownPath = `${owner.id}/avatar.png`;
    const upload = await owner.client.storage
      .from("avatars")
      .upload(ownPath, pngBlob(), { contentType: "image/png" });
    assertAllowed({ error: upload.error }, "subir a mi carpeta de avatar");

    // Sin sesion: el bucket es publico, asi que se puede leer.
    const publicUrl = owner.client.storage.from("avatars").getPublicUrl(ownPath);
    assert.ok(publicUrl.data.publicUrl.startsWith("http"));

    const anon = anonClient();
    const download = await anon.storage.from("avatars").download(ownPath);
    assert.equal(download.error, null, "el avatar se lee sin sesion");
    assert.ok((await download.data.arrayBuffer()).byteLength > 0);
  });

  it("avatars: no puedo escribir en la carpeta de otro", async () => {
    const { error } = await member.client.storage
      .from("avatars")
      .upload(`${owner.id}/suplantado.png`, pngBlob(), { contentType: "image/png" });
    assertDenied({ error }, "subir en la carpeta de otro");
  });
});
