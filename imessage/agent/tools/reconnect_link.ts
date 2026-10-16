import { defineTool } from "eve/tools";
import { z } from "zod";

import { checkGradescopeConnection, type GradescopeCheck } from "../lib/gradescope/store.ts";
import { appUrl } from "../lib/link.ts";
import { canvasHealth, reconnectUrl, serviceName, type ServiceHealth } from "../lib/reconnect.ts";
import { loadCanvasStatuses } from "../lib/reconnect-db.ts";
import { requireStudentId } from "../lib/student.ts";

type ConnectionStatus = "working" | "stopped_working" | "not_connected" | "unknown";

const FROM_GRADESCOPE: Record<GradescopeCheck, ConnectionStatus> = {
  working: "working",
  needs_reconnect: "stopped_working",
  not_connected: "not_connected",
  unknown: "unknown",
};

const FROM_CANVAS: Record<ServiceHealth, ConnectionStatus> = {
  ok: "working",
  broken: "stopped_working",
  absent: "not_connected",
  unknown: "unknown",
};

const NOTE: Record<ConnectionStatus, string> = {
  working: "It works right now. Give the link only if the student still wants to reconnect.",
  stopped_working: "It stopped working. Give the student the link on its own line; reconnecting takes about a minute.",
  not_connected: "It isn't connected yet. The same link connects it; give it on its own line.",
  unknown: "It couldn't be checked just now. The link still works if the student wants to reconnect.",
};

export default defineTool({
  description:
    "Gives the link where the student connects or reconnects Gradescope or Canvas to Polya, and whether that connection works right now. Use it when the student asks to connect or reconnect one, or when another tool says Gradescope or Canvas isn't connected, expired, or stopped working.",
  inputSchema: z.object({
    service: z.enum(["canvas", "gradescope"]).describe("Which connection: gradescope or canvas."),
  }),
  label: { start: () => "Checking your connection" },
  async execute({ service }, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    let status: ConnectionStatus;
    if (service === "gradescope") {
      status = FROM_GRADESCOPE[await checkGradescopeConnection(userId).catch(() => "unknown" as const)];
    } else {
      status = FROM_CANVAS[canvasHealth(await loadCanvasStatuses(userId))];
    }
    return {
      service: serviceName(service),
      link: reconnectUrl(service, appUrl()),
      works: status === "working" ? true : status === "unknown" ? null : false,
      status,
      note: NOTE[status],
    };
  },
});
