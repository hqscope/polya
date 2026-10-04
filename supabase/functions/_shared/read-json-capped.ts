// Reads a JSON request body under a hard byte cap, before anything parses it
// (Phase 9 A-9: polya-import parsed an unbounded body ahead of auth).
// Pure module (web-standard Request/TextDecoder only, no Deno globals) so
// Node's test runner can import it too.
//
// Two layers: a declared Content-Length over the cap is refused without
// parsing or buffering anything, and a body with no Content-Length (chunked)
// or a lying one is read as a stream and stops being kept as soon as it
// passes the cap. Nothing larger than `maxBytes` is ever buffered or parsed.
//
// A refused body is still read to the end and thrown away, chunk by chunk
// (constant memory). The Supabase edge runtime doesn't deliver a response
// while the request body is unread: returning 413 early, or cancelling the
// stream, left the caller waiting until the 150 s wall clock and a 504
// (observed live on polya-import v24, 2026-09-24).

export type CappedJson<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400; code: "bad_request" }
  | { ok: false; status: 413; code: "too_large" };

const INVALID = { ok: false, status: 400, code: "bad_request" } as const;
const TOO_LARGE = { ok: false, status: 413, code: "too_large" } as const;

export async function readJsonCapped<T = unknown>(
  request: Request,
  maxBytes: number,
): Promise<CappedJson<T>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      await discardBody(request);
      return INVALID;
    }
    if (length > maxBytes) {
      await discardBody(request);
      return TOO_LARGE;
    }
  }

  const text = await readTextCapped(request, maxBytes);
  if (text === "too_large") return TOO_LARGE;
  if (text === null) return INVALID;
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return INVALID;
  }
}

// The body as text, "too_large" once it passes the cap, or null when the
// stream itself fails (client went away mid-body).
async function readTextCapped(request: Request, maxBytes: number): Promise<string | "too_large" | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.length = 0;
        await discardRest(reader);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Reads whatever is left and keeps none of it. Errors (client went away) end
// the read; there's nothing left to deliver the response to anyway.
async function discardRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // discard
    }
  } catch {
    // ignore
  }
}

async function discardBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  await discardRest(request.body.getReader());
}
