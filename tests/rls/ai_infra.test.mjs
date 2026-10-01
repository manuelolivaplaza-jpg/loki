/**
 * RLS de la infraestructura de IA: cola de trabajos, cuota por espacio y uso.
 *
 * - ai_jobs: miembros crean a nombre propio y ven su espacio; el ciclo lo
 *   mueve solo la service role; reintentar pasa por retry_ai_job().
 * - reserve_ai_quota(): reserva atómica usuario+espacio; sin cuota no acumula.
 * - ai_space_usage_detail: solo admins; ai_space_limits: escribir, solo admins.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  assertAllowed,
  assertDenied,
  assertNoRows,
  createTestUser,
  createWorkspaceWith,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

describe("RLS: infraestructura de IA", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("ai-owner", "Owner");
    member = await createTestUser("ai-member", "Member");
    stranger = await createTestUser("ai-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("IA Infra"));
    await addMember(admin, ws, member.id, "member", "Member");
  });

  after(async () => {
    await purgeTestData();
  });

  // --- ai_jobs ----------------------------------------------------------------

  it("un miembro pide trabajos a su nombre; un ajeno no", async () => {
    assertAllowed(
      await member.client.from("ai_jobs").insert({
        workspace_id: ws,
        requested_by: member.id,
        type: "chat_summary",
        payload: {},
      }),
      "un miembro pide trabajos",
    );
    assertDenied(
      await stranger.client.from("ai_jobs").insert({
        workspace_id: ws,
        requested_by: stranger.id,
        type: "chat_summary",
        payload: {},
      }),
      "un ajeno no pide trabajos",
    );
    assertDenied(
      await member.client.from("ai_jobs").insert({
        workspace_id: ws,
        requested_by: owner.id,
        type: "chat_summary",
        payload: {},
      }),
      "nadie pide a nombre de otro",
    );
  });

  it("cada usuario ve solo trabajos de sus espacios", async () => {
    const { data: mine } = await member.client
      .from("ai_jobs")
      .select("id")
      .eq("workspace_id", ws);
    assert.ok((mine ?? []).length >= 1, "el miembro ve los trabajos del espacio");
    const { data: foreign } = await stranger.client
      .from("ai_jobs")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreign, "un ajeno no ve trabajos");
  });

  it("el cliente no mueve el ciclo (solo retry_ai_job lo reencola)", async () => {
    const { data: created } = await member.client
      .from("ai_jobs")
      .insert({
        workspace_id: ws,
        requested_by: member.id,
        type: "chat_summary",
        payload: {},
      })
      .select("id");
    const jobId = created[0].id;
    // Sin update/delete de cliente: no hay política, PostgREST responde 0 filas.
    const direct = await member.client
      .from("ai_jobs")
      .update({ status: "done" })
      .eq("id", jobId)
      .select("id");
    assert.equal((direct.data ?? []).length, 0, "el cliente no cambia status directo");
    // retry_ai_job sobre un trabajo queued devuelve false (no es error).
    const { data: retried, error } = await member.client.rpc("retry_ai_job", {
      p_job_id: jobId,
    });
    assert.equal(error, null, "retry_ai_job no falla");
    assert.equal(retried, false, "un queued no se reencola");
  });

  // --- reserve_ai_quota --------------------------------------------------------

  it("reserva cuota y la agota contra un límite bajo", async () => {
    // Límite diario de 3 unidades para el espacio (solo admins escriben).
    assertAllowed(
      await owner.client.from("ai_space_limits").upsert({
        workspace_id: ws,
        daily_units: 3,
        monthly_units: 100,
        updated_by: owner.id,
      }),
      "un admin fija límites",
    );
    assertDenied(
      await member.client.from("ai_space_limits").upsert({
        workspace_id: ws,
        daily_units: 9999,
        monthly_units: 9999,
        updated_by: member.id,
      }),
      "un miembro no fija límites",
    );
    const reserve = (units) =>
      member.client.rpc("reserve_ai_quota", {
        p_workspace_id: ws,
        p_user_id: member.id,
        p_job_type: "chat",
        p_units: units,
      });
    const first = await reserve(2);
    assert.equal(first.error, null, "reserva 1 sin error");
    assert.equal(first.data.allowed, true, "con cuota disponible permite");
    const second = await reserve(2);
    assert.equal(second.error, null, "reserva 2 sin error");
    assert.equal(second.data.allowed, false, "sin cuota no permite");
    assert.equal(second.data.reason, "space_daily", "el motivo es el día del espacio");
  });

  it("el desglose por miembro es solo para admins", async () => {
    const { data: mine } = await member.client
      .from("ai_space_usage")
      .select("units")
      .eq("workspace_id", ws);
    assert.ok(Array.isArray(mine), "el miembro ve los totales");
    const { data: detail } = await member.client
      .from("ai_space_usage_detail")
      .select("units")
      .eq("workspace_id", ws);
    assertNoRows(detail, "el miembro no ve el desglose");
    const { data: adminDetail } = await owner.client
      .from("ai_space_usage_detail")
      .select("units")
      .eq("workspace_id", ws);
    assert.ok((adminDetail ?? []).length >= 1, "el admin sí ve el desglose");
  });
});
