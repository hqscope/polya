// The import pump hands off to a fresh invocation after any PDF cycle, so a
// worker never burns past the edge CPU cap while it still holds the lease.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isCpuHeavySource, nextPumpMove } from "../supabase/functions/_shared/pump-plan.ts";

const NOW = 1_000_000;
const LATER = NOW + 30_000;

test("a cycle that advanced a PDF hands off even with wall budget left", () => {
  assert.equal(nextPumpMove([{ source_kind: "pdf" }], NOW, LATER), "handoff");
  assert.equal(
    nextPumpMove([{ source_kind: "html" }, { source_kind: "pdf" }, { source_kind: "transcript_vtt" }], NOW, LATER),
    "handoff",
  );
});

test("cheap cycles keep looping until the wall budget", () => {
  assert.equal(nextPumpMove([{ source_kind: "html" }], NOW, LATER), "continue");
  assert.equal(
    nextPumpMove([{ source_kind: "transcript_json" }, { source_kind: "html" }], NOW, LATER),
    "continue",
  );
  assert.equal(nextPumpMove([], NOW, LATER), "continue");
});

test("past the wall budget every cycle hands off", () => {
  assert.equal(nextPumpMove([{ source_kind: "html" }], LATER, LATER), "handoff");
  assert.equal(nextPumpMove([], LATER + 1, LATER), "handoff");
});

test("only PDFs count as CPU-heavy", () => {
  assert.equal(isCpuHeavySource({ source_kind: "pdf" }), true);
  for (const kind of ["html", "transcript_txt", "transcript_vtt", "transcript_srt", "transcript_json"]) {
    assert.equal(isCpuHeavySource({ source_kind: kind }), false, kind);
  }
});
