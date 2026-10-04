// polya-canvas — manage the student's Canvas connection.
// Actions: connect | status | list_courses | disconnect.
// The access token is written to the service-role-only platform connection
// (canvas_connections) and never returned to the client after entry. Every
// server-side use of it is audited (platform-hardening 8.1b).
import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { service } from "../_shared/service.ts";
import {
  CONNECTIONS_TABLE,
  finishTokenUse,
  loadConnectionWithToken,
  saveConnection,
  startTokenUse,
} from "../_shared/connections.ts";
import { outcomeForError } from "../_shared/token-audit.ts";
import { CanvasAuthError, CanvasClient, CanvasUrlError, normalizeBaseUrl } from "../_shared/canvas.ts";

const SOURCE = "polya-canvas";

// Local-only escape hatch for the mock-Canvas integration test. Never set in
// the deployed project.
const ALLOW_INSECURE_CANVAS = Deno.env.get("POLYA_ALLOW_INSECURE_CANVAS") === "1";

// Every request body here is a Canvas base_url/token pair or a connection id —
// well under this. Catches an unbounded-body abuse path (platform-hardening 2.13/R-21).
const MAX_BODY_BYTES = 64 * 1024;

interface ConnectBody {
  action: "connect";
  base_url: string;
  access_token: string;
}
interface SimpleBody {
  action: "status" | "list_courses" | "disconnect";
  connection_id?: string;
}
type Body = ConnectBody | SimpleBody;

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);
  }

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large.", code: "payload_too_large" }, 413);
    }

    const user = await requireAuthUser(request);
    const body = JSON.parse(rawBody) as Body;

    switch (body.action) {
      case "connect":
        return await handleConnect(user.id, body);
      case "status":
        return await handleStatus(user.id);
      case "list_courses":
        return await handleListCourses(user.id, body.connection_id);
      case "disconnect":
        return await handleDisconnect(user.id, body.connection_id);
      default:
        return json({ error: "Unknown action", code: "bad_request" }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: "unauthorized" }, error.status);
    }
    if (error instanceof CanvasUrlError) {
      return json({ error: error.message, code: "bad_url" }, 400);
    }
    if (error instanceof CanvasAuthError) {
      return json(
        { error: "Canvas didn't accept that access token. Double-check it and try again.", code: "canvas_auth" },
        400,
      );
    }
    console.error("[polya-canvas] error:", error);
    return json({ error: "Something went wrong connecting to Canvas.", code: "internal" }, 500);
  }
});

async function handleConnect(userId: string, body: ConnectBody): Promise<Response> {
  const baseUrl = normalizeBaseUrl(body.base_url, { allowInsecure: ALLOW_INSECURE_CANVAS });
  const client = new CanvasClient(baseUrl, body.access_token, {
    allowInsecure: ALLOW_INSECURE_CANVAS,
  });
  const auditId = await startTokenUse({
    userId,
    connectionId: null,
    baseUrl,
    source: SOURCE,
    action: "connect",
    operation: null,
  });
  let self: { id: string; name: string };
  try {
    self = await client.getSelf();
  } catch (error) {
    const failure = outcomeForError(error);
    await finishTokenUse(auditId, failure.outcome, { canvasStatus: failure.canvasStatus });
    throw error;
  }

  const { data, error } = await saveConnection(userId, baseUrl, body.access_token, self);

  if (error) {
    await finishTokenUse(auditId, "error");
    console.error("[polya-canvas] upsert failed:", error.message);
    return json({ error: "Couldn't save the Canvas connection.", code: "internal" }, 500);
  }
  await finishTokenUse(auditId, "ok", { canvasStatus: 200 });

  return json({
    connection_id: data.id,
    base_url: data.base_url,
    canvas_user_name: data.canvas_user_name,
    status: data.status,
  });
}

async function handleStatus(userId: string): Promise<Response> {
  const { data, error } = await service
    .from(CONNECTIONS_TABLE)
    .select("id, base_url, canvas_user_name, status")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    return json({ error: "Couldn't load your Canvas connection.", code: "internal" }, 500);
  }
  return json({ connections: data ?? [] });
}

async function handleListCourses(userId: string, connectionId?: string): Promise<Response> {
  const connection = await loadConnectionWithToken(userId, connectionId, {
    source: SOURCE,
    action: "query",
    operation: "list_courses",
  });
  if (!connection) {
    return json({ error: "Connect your Canvas first.", code: "no_connection" }, 404);
  }

  try {
    const client = new CanvasClient(connection.base_url, connection.access_token, {
      allowInsecure: ALLOW_INSECURE_CANVAS,
    });
    const courses = await client.listCourses();
    await finishTokenUse(connection.audit_id, "ok", { canvasStatus: 200 });
    return json({
      connection_id: connection.id,
      courses: courses.map((course) => ({
        canvas_course_id: course.id,
        name: course.name,
        code: course.code,
        term_name: course.termName,
      })),
    });
  } catch (error) {
    const failure = outcomeForError(error);
    await finishTokenUse(connection.audit_id, failure.outcome, { canvasStatus: failure.canvasStatus });
    if (error instanceof CanvasAuthError) {
      await service
        .from(CONNECTIONS_TABLE)
        .update({ status: "invalid" })
        .eq("id", connection.id)
        .eq("user_id", userId);
      return json(
        { error: "Your Canvas access token stopped working — paste a new one.", code: "canvas_auth" },
        400,
      );
    }
    throw error;
  }
}

// Disconnect deletes by id directly (no token decrypt needed, and a row with a
// broken credential must still be deletable). Each removed connection gets an
// audit row, like canvas-proxy's; a failed audit insert doesn't undo it.
async function handleDisconnect(userId: string, connectionId?: string): Promise<Response> {
  let query = service.from(CONNECTIONS_TABLE).delete().eq("user_id", userId);
  if (connectionId) {
    query = query.eq("id", connectionId);
  }
  const { data: removed } = await query.select("id, base_url");
  for (const row of (removed ?? []) as Array<{ id: string; base_url: string }>) {
    await startTokenUse({
      userId,
      connectionId: row.id,
      baseUrl: row.base_url,
      source: SOURCE,
      action: "disconnect",
      operation: null,
      outcome: "ok",
    }).catch(() => undefined); // logged by the sink
  }
  return json({ ok: true });
}
