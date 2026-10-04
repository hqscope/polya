import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_CLIENT,
  auditedDecrypt,
  type AuditFinish,
  type AuditRow,
  type AuditSink,
  auditRow,
  finishTokenUse,
  hostOf,
  outcomeForError,
  startTokenUse,
  TokenAuditError,
  type TokenUseEntry,
} from "../supabase/functions/_shared/token-audit.ts";
import { CanvasAuthError, CanvasHttpError } from "../supabase/functions/_shared/canvas.ts";

const NOW = new Date("2026-09-24T05:00:00.000Z");
const now = () => NOW;

const ENTRY: TokenUseEntry = {
  userId: "00000000-0000-4000-8000-000000000001",
  connectionId: "00000000-0000-4000-8000-000000000002",
  baseUrl: "https://bcourses.berkeley.edu",
  source: "polya-import",
  action: "query",
  operation: "import_pump",
};

// In-memory canvas_connection_audit; `failInsert` simulates the table being unwritable.
function sink(opts: { failInsert?: boolean } = {}) {
  const rows = new Map<number, AuditRow & Partial<AuditFinish>>();
  const events: string[] = [];
  let next = 1;
  const s: AuditSink = {
    async insert(row) {
      events.push("insert");
      if (opts.failInsert) return null;
      const id = next++;
      rows.set(id, { ...row });
      return id;
    },
    async update(id, patch) {
      events.push(`update:${patch.outcome}`);
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    },
  };
  return { sink: s, rows, events };
}

test("audit row has canvas-proxy's shape, labelled as Polya", () => {
  assert.deepEqual(auditRow(ENTRY, NOW), {
    user_id: ENTRY.userId,
    connection_id: ENTRY.connectionId,
    host: "bcourses.berkeley.edu",
    source: "polya-import",
    client: "polya",
    action: "query",
    operation: "import_pump",
    outcome: "started",
    finished_at: null,
  });
  assert.equal(AUDIT_CLIENT, "polya");
});

test("a row written already finished carries finished_at", () => {
  const row = auditRow({ ...ENTRY, action: "disconnect", operation: null, outcome: "ok" }, NOW);
  assert.equal(row.outcome, "ok");
  assert.equal(row.finished_at, NOW.toISOString());
});

test("hostOf takes the hostname and tolerates junk", () => {
  assert.equal(hostOf("https://canvas.example.edu"), "canvas.example.edu");
  assert.equal(hostOf("https://Canvas.Example.edu:443"), "canvas.example.edu");
  assert.equal(hostOf(null), null);
  assert.equal(hostOf("not a url"), null);
});

test("startTokenUse fails closed when the row can't be written", async () => {
  const { sink: s, events } = sink({ failInsert: true });
  await assert.rejects(() => startTokenUse(s, ENTRY, now), TokenAuditError);
  assert.deepEqual(events, ["insert"]);
});

test("finishTokenUse records outcome, Canvas status and pages", async () => {
  const { sink: s, rows } = sink();
  const id = await startTokenUse(s, ENTRY, now);
  await finishTokenUse(s, id, "canvas_http", { canvasStatus: 403, pages: 2 }, now);
  const row = rows.get(id)!;
  assert.equal(row.outcome, "canvas_http");
  assert.equal(row.canvas_status, 403);
  assert.equal(row.pages, 2);
  assert.equal(row.finished_at, NOW.toISOString());
});

test("auditedDecrypt writes the row before decrypting and ends it ok", async () => {
  const { sink: s, rows, events } = sink();
  const result = await auditedDecrypt(
    s,
    ENTRY,
    async () => {
      events.push("decrypt");
      return "plain";
    },
    now,
  );
  assert.equal(result.token, "plain");
  assert.deepEqual(events, ["insert", "decrypt", "update:ok"]);
  const row = rows.get(result.auditId)!;
  assert.equal(row.outcome, "ok");
  assert.equal(row.canvas_status, null);
});

test("auditedDecrypt never decrypts without an audit row", async () => {
  const { sink: s, events } = sink({ failInsert: true });
  let decrypted = false;
  await assert.rejects(
    () =>
      auditedDecrypt(
        s,
        ENTRY,
        async () => {
          decrypted = true;
          return "plain";
        },
        now,
      ),
    TokenAuditError,
  );
  assert.equal(decrypted, false);
  assert.deepEqual(events, ["insert"]);
});

test("auditedDecrypt marks a failed decrypt as error and rethrows", async () => {
  const { sink: s, rows, events } = sink();
  await assert.rejects(
    () =>
      auditedDecrypt(
        s,
        ENTRY,
        async () => {
          throw new Error("bad tag");
        },
        now,
      ),
    /bad tag/,
  );
  assert.deepEqual(events, ["insert", "update:error"]);
  assert.equal([...rows.values()][0]!.outcome, "error");
});

test("Canvas failures map to canvas-proxy's outcomes", () => {
  assert.deepEqual(outcomeForError(new CanvasAuthError()), { outcome: "canvas_auth", canvasStatus: 401 });
  assert.deepEqual(outcomeForError(new CanvasHttpError(404, "https://x.edu/api/v1/courses")), {
    outcome: "canvas_http",
    canvasStatus: 404,
  });
  assert.deepEqual(outcomeForError(new Error("boom")), { outcome: "error", canvasStatus: null });
});
