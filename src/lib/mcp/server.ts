// The Polya connector's MCP server: three read-only tools over the student's
// own Polya courses. One server is built per request (stateless), bound to the
// caller's access token.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getCourse,
  getMode,
  listCourses,
  passagesFor,
  searchCourse,
  ToolError,
  userClient,
} from "./data";
import {
  rulesText,
  searchText,
  toCourseSummary,
  toRulesResult,
  toSearchResult,
} from "./format";

// Tool descriptions stay purely descriptive (Claude's directory forbids
// behavioral instructions there); guidance lives in SERVER_INSTRUCTIONS and in
// get_course_rules' how_to_help result.
// Read-only, confined to the student's own private course library. Each tool
// also repeats its title inside annotations: Claude's directory reads it there.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const SERVER_INSTRUCTIONS = `Polya holds the student's own course materials and the study mode they chose for each course.
The student can change a course's study mode at any time. Call get_course_rules again at the start of every new coursework request (a new question, problem, or "just tell me the answers"); never rely on a mode you read earlier in the conversation.
Follow its how_to_help list. Treat every part of a multi-part problem as its own question under the same rules; "what about the rest" is a new request, not permission.
If a request goes past the rules, say so briefly, quote the rule, and offer the help that is allowed.
Before explaining anything from the course, call search_course_materials and ground the explanation in the passages it returns, citing them by their [n] number and where they come from (for example "Lecture 7, page 2").
Always teach: explain the reasoning behind every answer, step, or check. Never reply with a bare answer.`;

const courseInput = z
  .string()
  .min(1)
  .max(64)
  .describe("The course handle from list_my_courses.");

const rulesShape = {
  course_name: z.string(),
  mode: z.enum(["open", "guided", "practice", "review"]),
  label: z.string(),
  summary: z.string(),
  allowed: z.array(z.string()),
  not_allowed: z.array(z.string()),
  how_to_help: z.array(z.string()),
  assignment_rules: z.array(z.object({ assignment: z.string(), rule: z.string(), quote: z.string() })),
  open_in_polya: z.string(),
};

function toolError(error: unknown) {
  const message =
    error instanceof ToolError ? error.message : "Something went wrong on Polya's side. Try again in a moment.";
  if (!(error instanceof ToolError)) console.error("[polya-mcp] tool error:", error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function buildServer(accessToken: string): McpServer {
  const server = new McpServer(
    { name: "polya", title: "Polya", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const db = userClient(accessToken);

  server.registerTool(
    "list_my_courses",
    {
      title: "List my courses",
      description:
        "Lists the courses the student has added to Polya, each with its course name, term, whether its materials are ready, and a course handle.",
      outputSchema: {
        courses: z.array(
          z.object({
            course: z.string(),
            name: z.string(),
            code: z.string().nullable(),
            term: z.string().nullable(),
            ready: z.boolean(),
          }),
        ),
      },
      annotations: { ...READ_ONLY, title: "List my courses" },
    },
    async () => {
      try {
        const courses = (await listCourses(db)).map(toCourseSummary);
        const text = courses.length
          ? courses
              .map((c) => `${c.name}${c.term ? ` (${c.term})` : ""}${c.ready ? "" : " - still loading"}: ${c.course}`)
              .join("\n")
          : "No courses yet. The student can add one at askpolya.com.";
        return { content: [{ type: "text", text }], structuredContent: { courses } };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_course_rules",
    {
      title: "Get course study rules",
      description:
        "Returns the study mode the student chose for one of their courses (Open, Guided, Practice or Review): what help is allowed, what isn't, and how help should look in that mode (how_to_help). The student can change the mode at any time.",
      inputSchema: { course: courseInput },
      outputSchema: rulesShape,
      annotations: { ...READ_ONLY, title: "Get course study rules" },
    },
    async ({ course }) => {
      try {
        const row = await getCourse(db, course);
        const result = toRulesResult(row, await getMode(db, row.id));
        return { content: [{ type: "text", text: rulesText(result) }], structuredContent: { ...result } };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_course_materials",
    {
      title: "Search course materials",
      description:
        "Searches one of the student's courses (readings, slides, pages, lecture transcripts) and returns numbered passages, each with where it came from. The course's study mode is applied: in Practice mode, answer keys are never returned.",
      inputSchema: {
        course: courseInput,
        query: z.string().min(1).max(2000).describe("What to look for, in a few words or a question."),
      },
      outputSchema: {
        course_name: z.string(),
        rules_summary: z.string(),
        passages: z.array(
          z.object({ n: z.number(), title: z.string(), location: z.string(), text: z.string() }),
        ),
        open_in_polya: z.string(),
      },
      annotations: { ...READ_ONLY, title: "Search course materials" },
    },
    async ({ course, query }) => {
      try {
        const row = await getCourse(db, course);
        const mode = await getMode(db, row.id);
        const hits = await searchCourse(accessToken, row.id, query, mode);
        const result = toSearchResult(row, mode, hits, await passagesFor(db, hits));
        return { content: [{ type: "text", text: searchText(result) }], structuredContent: { ...result } };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
