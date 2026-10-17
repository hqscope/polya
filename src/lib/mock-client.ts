import { invokeFunction } from "@/lib/functions";
import type { MockRow } from "@/lib/study";

export interface BuildState {
  status: MockRow["status"];
  built: number;
  total: number;
  /** Ready with fewer questions than asked for (no more could be written today). */
  short?: boolean;
}

type Listener = (state: BuildState) => void;

// Each step adds checked questions (writing one more batch when the course's
// question bank runs short), so a mock fills up over several calls.
const MAX_STEPS = 30;
const runs = new Map<string, { listeners: Set<Listener>; promise: Promise<BuildState> }>();

// Fills a mock exam until it's ready. The coach's card and the mock page can
// both ask at once; they share one run.
export function buildMock(mockId: string, onProgress?: Listener): Promise<BuildState> {
  const existing = runs.get(mockId);
  if (existing) {
    if (onProgress) existing.listeners.add(onProgress);
    return existing.promise;
  }
  const listeners = new Set<Listener>(onProgress ? [onProgress] : []);
  const promise = (async () => {
    try {
      let state: BuildState = { status: "building", built: 0, total: 0 };
      for (let step = 0; step < MAX_STEPS; step++) {
        state = await invokeFunction<BuildState>("polya-study", { action: "build_mock", mock_id: mockId });
        for (const listener of listeners) listener(state);
        if (state.status !== "building") break;
      }
      return state;
    } finally {
      runs.delete(mockId);
    }
  })();
  runs.set(mockId, { listeners, promise });
  return promise;
}
