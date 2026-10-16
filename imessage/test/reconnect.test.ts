import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CheckInLink } from "../agent/lib/check-ins.ts";
import { GradescopeError } from "../agent/lib/gradescope/client.ts";
import { describeGradescopeError, lastErrorCode } from "../agent/lib/gradescope/store.ts";
import {
  canvasHealth,
  formatReconnectedMessage,
  formatReconnectMessage,
  gradescopeHealth,
  needsGradescopeReconnect,
  planReconnectNotices,
  processReconnectNotices,
  RECONNECT_PREFIX,
  reconnectUrl,
  type ReconnectClaim,
  type ReconnectDeps,
  type ReconnectHealth,
  type ReconnectNotice,
  type ReconnectService,
} from "../agent/lib/reconnect.ts";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const APP = "https://askpolya.com";
// Thu Oct 15 2026, 9:00 AM in Los Angeles (PDT): outside the default 22 -> 8 quiet hours.
const NOW = new Date("2026-10-15T16:00:00Z");
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function health(overrides: Partial<ReconnectHealth> = {}): ReconnectHealth {
  return { canvas: "ok", gradescope: "ok", ...overrides };
}

describe("reconnect links", () => {
  it("points Gradescope at /connect/gradescope and Canvas at /app/connect", () => {
    assert.equal(reconnectUrl("gradescope", APP), "https://askpolya.com/connect/gradescope");
    assert.equal(reconnectUrl("canvas", APP), "https://askpolya.com/app/connect");
    assert.equal(reconnectUrl("canvas", "http://localhost:3000/"), "http://localhost:3000/app/connect");
  });
});

describe("connection health", () => {
  it("calls Canvas broken only when a connection is invalid and none is active", () => {
    assert.equal(canvasHealth(["invalid"]), "broken");
    assert.equal(canvasHealth(["invalid", "active"]), "ok");
    assert.equal(canvasHealth(["active"]), "ok");
    assert.equal(canvasHealth([]), "absent");
    assert.equal(canvasHealth(null), "unknown");
  });

  it("treats only sign-in failures the student can fix as a Gradescope reconnect", () => {
    for (const code of ["session_expired", "invalid_credentials", "sso_required"] as const) {
      assert.equal(needsGradescopeReconnect(new GradescopeError(code, "x")), true, code);
    }
    for (const code of ["network", "http", "login_failed", "missing_token"] as const) {
      assert.equal(needsGradescopeReconnect(new GradescopeError(code, "x")), false, code);
    }
    assert.equal(needsGradescopeReconnect(new Error("session_expired")), false);
  });

  it("maps the loop's Gradescope read to health", () => {
    assert.equal(gradescopeHealth("connected"), "ok");
    assert.equal(gradescopeHealth("not_connected"), "absent");
    assert.equal(gradescopeHealth("needs_reconnect"), "broken");
    assert.equal(gradescopeHealth("error"), "unknown");
  });

  it("stores last_error with its code first, so it can be read back", () => {
    const stored = describeGradescopeError(new GradescopeError("sso_required", "school sign-in required"));
    assert.equal(stored, "sso_required: school sign-in required");
    assert.equal(lastErrorCode(stored), "sso_required");
    assert.equal(lastErrorCode(null), null);
    assert.equal(lastErrorCode("Something without a code"), null);
  });
});

describe("planReconnectNotices", () => {
  const plan = (h: Partial<ReconnectHealth>, notices: ReconnectNotice[] = []) =>
    planReconnectNotices({ health: health(h), notices, now: NOW });

  it("texts about a broken service that has no notice yet", () => {
    assert.deepEqual(plan({ gradescope: "broken" }), { send: ["gradescope"], clear: [] });
    assert.deepEqual(plan({ canvas: "broken" }), { send: ["canvas"], clear: [] });
  });

  it("waits 24 hours between texts while it stays broken", () => {
    assert.deepEqual(plan({ gradescope: "broken" }, [{ service: "gradescope", textedAt: hoursAgo(23.9) }]).send, []);
    assert.deepEqual(plan({ gradescope: "broken" }, [{ service: "gradescope", textedAt: hoursAgo(24) }]).send, ["gradescope"]);
    assert.deepEqual(plan({ gradescope: "broken" }, [{ service: "gradescope", textedAt: hoursAgo(30) }]).send, ["gradescope"]);
  });

  it("keeps each service's 24 hours separate", () => {
    const notices: ReconnectNotice[] = [{ service: "gradescope", textedAt: hoursAgo(2) }];
    assert.deepEqual(plan({ gradescope: "broken", canvas: "broken" }, notices).send, ["canvas"]);
  });

  it("texts about both when both broke", () => {
    assert.deepEqual(plan({ gradescope: "broken", canvas: "broken" }).send, ["gradescope", "canvas"]);
  });

  it("clears the notice once the service works again or is gone", () => {
    const notices: ReconnectNotice[] = [
      { service: "gradescope", textedAt: hoursAgo(2) },
      { service: "canvas", textedAt: hoursAgo(2) },
    ];
    assert.deepEqual(plan({ gradescope: "ok", canvas: "absent" }, notices), { send: [], clear: ["gradescope", "canvas"] });
  });

  it("leaves things alone when it can't tell", () => {
    const notices: ReconnectNotice[] = [{ service: "gradescope", textedAt: hoursAgo(30) }];
    assert.deepEqual(plan({ gradescope: "unknown" }, notices), { send: [], clear: [] });
    assert.deepEqual(plan({ gradescope: "unknown" }), { send: [], clear: [] });
  });

  it("does nothing for working services with no notice", () => {
    assert.deepEqual(plan({}), { send: [], clear: [] });
  });
});

describe("reconnect messages", () => {
  it("lists each broken service with its link", () => {
    const message = formatReconnectMessage(["gradescope", "canvas"], APP);
    assert.ok(message.startsWith(`${RECONNECT_PREFIX}\n\n`));
    assert.match(message, /service: Gradescope\nstatus: stopped working\nproblem: .+\nlink: https:\/\/askpolya\.com\/connect\/gradescope/);
    assert.match(message, /service: Canvas\nstatus: stopped working\nproblem: .+\nlink: https:\/\/askpolya\.com\/app\/connect/);
  });

  it("says when the student reconnected", () => {
    assert.equal(formatReconnectedMessage("gradescope"), `${RECONNECT_PREFIX}\n\nservice: Gradescope\nstatus: reconnected`);
  });
});

// --- One pass with fake I/O -------------------------------------------------------------------

function link(overrides: Partial<CheckInLink> = {}): CheckInLink {
  return {
    userId: STUDENT,
    threadId: "imessage:thread-1",
    timezone: "America/Los_Angeles",
    checkInsEnabled: true,
    quietStart: 22,
    quietEnd: 8,
    ...overrides,
  };
}

interface FakeOptions {
  links?: CheckInLink[];
  health?: Partial<Record<string, Partial<ReconnectHealth>>>;
  notices?: Record<string, ReconnectNotice[]>;
  /** Missing notices table. */
  noTable?: boolean;
  confirm?: (userId: string, service: ReconnectService) => boolean;
  claim?: (userId: string, service: ReconnectService, hadNotice: boolean) => ReconnectClaim;
  sendFails?: boolean;
}

function fake(options: FakeOptions = {}) {
  const sent: { threadId: string; userId: string; message: string }[] = [];
  const claims: { userId: string; service: ReconnectService; hadNotice: boolean }[] = [];
  const cleared: { userId: string; services: ReconnectService[] }[] = [];
  const healthChecks: string[] = [];
  const deps: ReconnectDeps = {
    loadLinks: async () => options.links ?? [link()],
    loadNotices: async (userId) => (options.noTable ? null : (options.notices?.[userId] ?? [])),
    checkHealth: async (userId) => {
      healthChecks.push(userId);
      return health(options.health?.[userId] ?? {});
    },
    confirmBroken: async (userId, service) => options.confirm?.(userId, service) ?? true,
    claim: async (userId, service, hadNotice) => {
      claims.push({ userId, service, hadNotice });
      return options.claim?.(userId, service, hadNotice) ?? "won";
    },
    clear: async (userId, services) => {
      cleared.push({ userId, services: [...services] });
    },
    send: async (threadId, userId, message) => {
      if (options.sendFails) throw new Error("hand-off failed");
      sent.push({ threadId, userId, message });
    },
  };
  return { deps, sent, claims, cleared, healthChecks };
}

describe("processReconnectNotices", () => {
  it("claims, then texts one message to the student's thread", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken" } } });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.deepEqual(counts, { students: 1, messagesSent: 1, cleared: 0, failed: 0, unavailable: false });
    assert.deepEqual(f.claims, [{ userId: STUDENT, service: "gradescope", hadNotice: false }]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.threadId, "imessage:thread-1");
    assert.match(f.sent[0]?.message ?? "", /link: https:\/\/askpolya\.com\/connect\/gradescope/);
  });

  it("puts both services in one message", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken", canvas: "broken" } } });
    await processReconnectNotices(f.deps, NOW, APP);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]?.message ?? "", /Gradescope[\s\S]+Canvas/);
  });

  it("doesn't text again within 24 hours, and claims a stale notice as an update", async () => {
    const recent = fake({
      health: { [STUDENT]: { gradescope: "broken" } },
      notices: { [STUDENT]: [{ service: "gradescope", textedAt: hoursAgo(5) }] },
    });
    await processReconnectNotices(recent.deps, NOW, APP);
    assert.equal(recent.sent.length, 0);
    assert.equal(recent.claims.length, 0);

    const stale = fake({
      health: { [STUDENT]: { gradescope: "broken" } },
      notices: { [STUDENT]: [{ service: "gradescope", textedAt: hoursAgo(25) }] },
    });
    await processReconnectNotices(stale.deps, NOW, APP);
    assert.deepEqual(stale.claims, [{ userId: STUDENT, service: "gradescope", hadNotice: true }]);
    assert.equal(stale.sent.length, 1);
  });

  it("doesn't text when an overlapping run already claimed it", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken" } }, claim: () => "lost" });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.equal(counts.messagesSent, 0);
    assert.equal(f.sent.length, 0);
  });

  it("skips a service the database says is already fixed", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken", canvas: "broken" } }, confirm: (_u, s) => s !== "gradescope" });
    await processReconnectNotices(f.deps, NOW, APP);
    assert.deepEqual(
      f.claims.map((c) => c.service),
      ["canvas"],
    );
    assert.doesNotMatch(f.sent[0]?.message ?? "", /Gradescope/);
  });

  it("clears notices for services that work again", async () => {
    const f = fake({ notices: { [STUDENT]: [{ service: "canvas", textedAt: hoursAgo(3) }] } });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.deepEqual(f.cleared, [{ userId: STUDENT, services: ["canvas"] }]);
    assert.equal(counts.cleared, 1);
    assert.equal(f.sent.length, 0);
  });

  it("stays quiet during quiet hours, without reading anything", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken" } } });
    // 11:30 PM in Los Angeles.
    await processReconnectNotices(f.deps, new Date("2026-10-16T06:30:00Z"), APP);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.healthChecks, []);
  });

  it("only looks at students with check-ins on and a thread", async () => {
    const f = fake({
      links: [link({ checkInsEnabled: false }), link({ userId: OTHER, threadId: null })],
      health: { [STUDENT]: { gradescope: "broken" }, [OTHER]: { gradescope: "broken" } },
    });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.equal(counts.students, 0);
    assert.equal(f.sent.length, 0);
  });

  it("texts nothing until the notices table exists", async () => {
    const f = fake({ noTable: true, health: { [STUDENT]: { gradescope: "broken" } } });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.equal(counts.unavailable, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.claims.length, 0);
  });

  it("frees the claims when the text fails, so the next run retries", async () => {
    const f = fake({ health: { [STUDENT]: { gradescope: "broken" } }, sendFails: true });
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.equal(counts.failed, 1);
    assert.deepEqual(f.cleared, [{ userId: STUDENT, services: ["gradescope"] }]);
  });

  it("keeps going after one student fails", async () => {
    const f = fake({
      links: [link(), link({ userId: OTHER, threadId: "imessage:thread-2" })],
      health: { [STUDENT]: { gradescope: "broken" }, [OTHER]: { canvas: "broken" } },
    });
    f.deps.checkHealth = async (userId) => {
      if (userId === STUDENT) throw new Error("db down");
      return health({ canvas: "broken" });
    };
    const counts = await processReconnectNotices(f.deps, NOW, APP);
    assert.deepEqual(counts, { students: 2, messagesSent: 1, cleared: 0, failed: 1, unavailable: false });
    assert.equal(f.sent[0]?.userId, OTHER);
  });
});
