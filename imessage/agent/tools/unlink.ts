import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { serviceDb } from "../lib/db.ts";
import { deleteLink } from "../lib/link.ts";
import { requireStudentId } from "../lib/student.ts";

export default defineTool({
  description:
    "Disconnects this phone number from the student's Polya account. Polya stops replying to course questions here and stops check-ins until the student connects again (texting Polya sends a new link). Their Polya account and courses are not affected. The student confirms before it runs.",
  inputSchema: z.object({}),
  approval: {
    request: always(),
    prompt: () =>
      "Disconnect this number from your Polya account? I'll stop check-ins and won't see your courses here until you connect again. Your account and courses stay as they are.",
  },
  label: { start: () => "Disconnecting this number" },
  async execute(_input, ctx) {
    const userId = requireStudentId(ctx.session.auth);
    const removed = await deleteLink(serviceDb(), userId);
    return {
      unlinked: true,
      already_unlinked: !removed,
      reconnect: "Texting Polya again sends a new link to connect.",
    };
  },
});
