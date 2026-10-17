// Server-Sent Events decoder for the edge functions' streams. Feed it decoded
// text in whatever chunks the network delivers; it returns each complete event
// once its terminating blank line arrives. Pure and dependency-free so
// `tests/` can import it under Node's test runner.
//
// Follows the SSE line rules: LF, CRLF, or CR line endings; "field: value"
// with one optional space after the colon; repeated `data:` lines joined with
// "\n"; `:` comment lines and `id:` / `retry:` ignored. Every payload we send
// is JSON, so a malformed one is dropped (with a warning) instead of throwing
// and killing the rest of the answer.

export interface SSEEvent {
  event: string;
  data: unknown;
}

export interface SSEDecoder {
  push(chunk: string): SSEEvent[];
}

export function createSSEDecoder(): SSEDecoder {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = (out: SSEEvent[]) => {
    if (dataLines.length) {
      const raw = dataLines.join("\n");
      try {
        out.push({ event: eventName || "message", data: JSON.parse(raw) });
      } catch {
        console.warn(`[sse] dropped a malformed "${eventName || "message"}" event`);
      }
    }
    eventName = "";
    dataLines = [];
  };

  const line = (text: string, out: SSEEvent[]) => {
    if (text === "") {
      dispatch(out);
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  };

  // A CR ends a line on its own, but a CRLF split across chunks must not end
  // two lines, so remember to skip an LF that opens the next chunk.
  let skipLF = false;

  return {
    push(chunk: string): SSEEvent[] {
      const out: SSEEvent[] = [];
      buffer += chunk;
      let start = 0;
      if (skipLF && buffer) {
        if (buffer.startsWith("\n")) start = 1;
        skipLF = false;
      }
      for (let i = start; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;
        line(buffer.slice(start, i), out);
        if (ch === "\r") {
          if (i === buffer.length - 1) skipLF = true;
          else if (buffer[i + 1] === "\n") i++;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
}
