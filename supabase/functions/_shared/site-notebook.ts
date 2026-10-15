// Jupyter notebooks and plain-text files linked from a course website, turned
// into the small HTML documents the import pump already knows how to read
// (advanceHtml strips them to text, chunks, and embeds). Not wired into the
// pump yet: see site-policy.ts notebookLinkToRaw for where the files come from. Outputs are dropped:
// a handout notebook's questions and code are the course text; plots and
// tables of results are not. Pure module, so Node's test runner covers it.
import { escapeHtml } from "./site-assignments.ts";

interface NotebookCell {
  cell_type?: unknown;
  source?: unknown;
}

function cellSource(cell: NotebookCell): string {
  const source = cell.source;
  if (Array.isArray(source)) return source.map((line) => String(line ?? "")).join("");
  return typeof source === "string" ? source : "";
}

// Inline images (data: URIs) are kilobytes of base64 that would land in the
// text as noise.
function dropInlineData(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{40,}/gi, " ");
}

function documentShell(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head>` +
    `<body><h1>${safeTitle}</h1>\n${body}\n</body></html>`;
}

/** HTML for a .ipynb file's text, or null when it isn't a notebook. */
export function notebookToHtml(raw: string, title: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const notebook = parsed as { cells?: unknown; worksheets?: Array<{ cells?: unknown }> };
  const cells = Array.isArray(notebook.cells)
    ? notebook.cells
    : Array.isArray(notebook.worksheets?.[0]?.cells)
      ? notebook.worksheets![0]!.cells
      : null;
  if (!Array.isArray(cells)) return null;

  const blocks: string[] = [];
  for (const cell of cells as NotebookCell[]) {
    const source = dropInlineData(cellSource(cell)).trim();
    if (!source) continue;
    if (cell.cell_type === "code") {
      blocks.push(`<pre>${escapeHtml(source)}</pre>`);
    } else {
      blocks.push(`<div>${escapeHtml(source)}</div>`);
    }
  }
  if (blocks.length === 0) return null;
  return documentShell(title, blocks.join("\n"));
}

/** HTML for a plain-text or Markdown file. */
export function textToHtml(raw: string, title: string): string {
  return documentShell(title, `<div>${escapeHtml(dropInlineData(raw))}</div>`);
}
