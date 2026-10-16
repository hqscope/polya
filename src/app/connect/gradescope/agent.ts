// Server only: calls the Polya iMessage agent's Gradescope endpoint with the
// shared secret. Import it from the page and the server action, never from a
// client component.
//
// The request body holds the student's Gradescope cookie or password, so
// nothing here logs a body, a URL with secrets, or an error message: only an
// HTTP status or an error's name.

import {
  CONNECT_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  agentConnectUrl,
  connectRequestBody,
  parseConnectResponse,
  parseStatusResponse,
  statusRequestBody,
  type ConnectRequest,
  type ConnectResult,
  type GradescopeStatus,
} from "@/lib/gradescope-connect";

function agentConfig(): { url: string; secret: string } | null {
  const secret = process.env.POLYA_CONNECT_SECRET?.trim();
  if (!secret) return null;
  return { url: agentConnectUrl(process.env.POLYA_IMESSAGE_AGENT_URL), secret };
}

/** False when POLYA_CONNECT_SECRET isn't set; the page shows the outage notice. */
export function isGradescopeConnectConfigured(): boolean {
  return agentConfig() !== null;
}

type AgentReply =
  | { status: number; body: unknown }
  | { failure: "timeout" | "unreachable" };

async function postToAgent(payload: object, timeoutMs: number): Promise<AgentReply> {
  const config = agentConfig();
  if (!config) return { failure: "unreachable" };

  let status: number;
  let text: string;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect with the secret and the student's cookie.
      redirect: "error",
      cache: "no-store",
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.warn(`[polya] Gradescope agent request failed: ${name}`);
    return { failure: name === "TimeoutError" ? "timeout" : "unreachable" };
  }

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; the parsers treat a null body as an unknown failure.
  }
  return { status, body };
}

/** Whether the student's Gradescope is connected, or "unknown" if the agent can't say. */
export async function fetchGradescopeStatus(userId: string): Promise<GradescopeStatus> {
  const reply = await postToAgent(statusRequestBody(userId), STATUS_TIMEOUT_MS);
  if ("failure" in reply) return "unknown";
  const status = parseStatusResponse(reply.status, reply.body);
  if (status === "unknown") {
    console.warn(`[polya] Gradescope status: unexpected reply (HTTP ${reply.status})`);
  }
  return status;
}

/** Sends the student's cookie or email and password to the agent to connect Gradescope. */
export async function sendGradescopeConnect(
  userId: string,
  request: ConnectRequest,
): Promise<ConnectResult> {
  const reply = await postToAgent(connectRequestBody(userId, request), CONNECT_TIMEOUT_MS);
  if ("failure" in reply) {
    return { ok: false, code: reply.failure === "timeout" ? "timeout" : "unknown" };
  }
  const result = parseConnectResponse(reply.status, reply.body);
  if (!result.ok && result.code === "unknown") {
    console.warn(`[polya] Gradescope connect: unexpected reply (HTTP ${reply.status})`);
  }
  return result;
}
