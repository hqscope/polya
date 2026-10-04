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

// Read-only, confined to the student's own private course library.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export const SERVER_INSTRUCTIONS = `Polya holds the student's own course materials and the study mode they chose for each course.
Before helping with coursework for a Polya course, call get_course_rules and keep your help within those rules.
If the student asks for help the rules don't allow, say so, quote the rule, and offer the kind of help that is allowed.
Use search_course_materials to ground explanations in the course, and cite passages by their [n] number.`;

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
        "Lists the courses the student has added to Polya, with the handle other Polya tools need. Use it when the student mentions a class and you don't have its handle yet.",
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
      annotations: READ_ONLY,
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
        "Returns the study rules for one of the student's courses: what kind of help is allowed and what isn't. Call it before helping with that course's coursework, and follow it.",
      inputSchema: { course: courseInput },
      outputSchema: rulesShape,
      annotations: READ_ONLY,
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
        "Searches one of the student's courses (readings, slides, pages, lecture transcripts) and returns numbered passages with where they came from. The course's study rules are applied: in practice mode, answer keys are never returned.",
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
      annotations: READ_ONLY,
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
