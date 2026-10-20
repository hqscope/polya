// Noel's personal MCP hub, resolved per turn: it exists only when the turn belongs to Noel's own
// linked Polya account (student texts and check-ins both carry polyaUserId). Read-only allowlist.
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { HUB_READ_TOOLS, hubFor } from "../lib/noel-hub.ts";
import { studentIdFrom } from "../lib/student.ts";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const hub = hubFor(studentIdFrom(ctx.session.auth));
      if (!hub) return null;
      return defineMcpClientConnection({
        url: hub.url,
        description:
          "Noel's personal hub, read-only: his Gmail, Google Calendar, Drive, Docs, Sheets, Tasks, Slack, bCourses (with grades and feedback), GitHub, Vercel, Scope metrics, scientific literature, and more.",
        instanceKey: `noel-hub:${hub.ownerId}`,
        auth: { getToken: async () => ({ token: hub.token }) },
        tools: { allow: [...HUB_READ_TOOLS] },
      });
    },
  },
});
