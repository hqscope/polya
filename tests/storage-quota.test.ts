import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertStorageRoom,
  checkStorageRoom,
  STORAGE_FULL_CODE,
  STORAGE_FULL_MESSAGE,
  STORAGE_FULL_STATUS,
  StorageCheckUnavailableError,
  StorageFullError,
  storageFullBody,
} from "../supabase/functions/_shared/storage-quota.ts";
import type { RpcClient } from "../supabase/functions/_shared/rate-limit.ts";

// Fake storage_upload_check: a canned reply, an RPC error, or a throw.
function checker(reply: { data?: unknown; error?: unknown; throws?: boolean }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (reply.throws) return Promise.reject(new Error("network down"));
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  };
  return { client, calls };
}

const USER = "0e5f0000-0000-4000-8000-0000000000a1";
const PATH = `${USER}/course/source/original.pdf`;

test("asks storage_upload_check with the user, bucket and exact path", async () => {
  const { client, calls } = checker({ data: { allowed: true, used_bytes: 10, quota_bytes: 500 } });
  const result = await checkStorageRoom(client, USER, "polya_documents", PATH);
  assert.deepEqual(result, { allowed: true, usedBytes: 10, quotaBytes: 500 });
  assert.deepEqual(calls, [
    {
      fn: "storage_upload_check",
      args: { p_user_id: USER, p_bucket: "polya_documents", p_name: PATH },
    },
  ]);
});

test("a quota-only check passes a null path", async () => {
  const { client, calls } = checker({ data: { allowed: true, used_bytes: 0, quota_bytes: 500 } });
  await assertStorageRoom(client, USER, "polya_documents", null);
  assert.equal(calls[0]!.args.p_name, null);
});

test("over quota throws StorageFullError carrying the numbers", async () => {
  const { client } = checker({
    data: { allowed: false, used_bytes: 600_000_000, quota_bytes: 500_000_000 },
  });
  await assert.rejects(
    () => assertStorageRoom(client, USER, "polya_documents", PATH),
    (err: unknown) => {
      assert.ok(err instanceof StorageFullError);
      assert.equal(err.code, STORAGE_FULL_CODE);
      assert.equal(err.usedBytes, 600_000_000);
      assert.equal(err.quotaBytes, 500_000_000);
      assert.equal(err.message, STORAGE_FULL_MESSAGE);
      return true;
    },
  );
});

test("allowed passes without throwing (under quota, or an overwrite)", async () => {
  const { client } = checker({ data: { allowed: true, used_bytes: 600_000_000, quota_bytes: 500_000_000 } });
  await assertStorageRoom(client, USER, "polya_documents", PATH);
});

test("fails closed as a retryable error when the check can't run", async () => {
  for (const reply of [
    { error: { message: "permission denied" } },
    { throws: true },
    { data: null },
    { data: { used_bytes: 1 } },
    { data: { allowed: "true" } },
  ]) {
    const { client } = checker(reply);
    await assert.rejects(
      () => assertStorageRoom(client, USER, "polya_documents", PATH),
      (err: unknown) => {
        assert.ok(err instanceof StorageCheckUnavailableError, JSON.stringify(reply));
        assert.equal((err as { transient?: boolean }).transient, true);
        return true;
      },
    );
  }
});

test("numbers arriving as strings (bigint over JSON) still parse", async () => {
  const { client } = checker({ data: { allowed: false, used_bytes: "600000000", quota_bytes: "500000000" } });
  const result = await checkStorageRoom(client, USER, "polya_documents", PATH);
  assert.deepEqual(result, { allowed: false, usedBytes: 600_000_000, quotaBytes: 500_000_000 });
});

test("the HTTP body is the storage_full shape clients match on", () => {
  assert.equal(STORAGE_FULL_STATUS, 403);
  assert.deepEqual(storageFullBody(new StorageFullError(600, 500)), {
    error: STORAGE_FULL_MESSAGE,
    code: "storage_full",
    used_bytes: 600,
    quota_bytes: 500,
  });
});

test("the message is user-facing: no implementation words", () => {
  for (const banned of ["quota", "bucket", "Supabase", "server", "database", "RLS", "token"]) {
    assert.ok(!STORAGE_FULL_MESSAGE.toLowerCase().includes(banned.toLowerCase()), banned);
  }
});
