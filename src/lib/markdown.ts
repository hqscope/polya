// The slice of Markdown the tutor writes — headings, lists, tables, fenced
// code, quotes, rules, and inline emphasis/code/links — parsed into plain data
// so React renders it (text is always escaped; raw HTML never renders). Pure
// and dependency-free so `tests/` can import it under Node's test runner.
//
// Hand-rolled on purpose: the off-the-shelf math plugins are built around
// single-$ math, which would eat dollar amounts ("win $5"), and they don't know
// our \( … \) / \[ … \] delimiters or [n] citation pills.
//
// Ordering matters in two places:
// - Blocks: a display-math run (\[ … \] or $$ … $$) can span lines, blank
//   lines, or lines that start with "-", "|" or "#". Its newlines never split
//   blocks, and while streaming neither do the newlines after an opener whose
//   closer hasn't arrived yet.
// - Inline: code and math are pulled out first, so emphasis rules never touch
//   LaTeX subscripts and a [1] inside math or code is not a citation.

import { mathRanges, openMathStart } from "./math-text.ts";
import { segmentCitations } from "./citations.ts";

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { type: "table"; align: MdAlign[]; header: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string; open: boolean }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "hr" };

/** A list item. `children` holds at most one nested list. */
export interface MdItem {
  text: string;
  children: MdBlock[];
}

export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong" | "em"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "math"; tex: string; display: boolean }
  | { type: "cite"; n: number }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "break" };

export interface ParseOptions {
  /**
   * The text is still arriving. Unlocks the partial shapes that only make
   * sense mid-answer: an unclosed display-math run holds the rest together,
   * and a lone `| a | b |` header line shows as a table before its rows.
   */
  streaming?: boolean;
}

const MAX_QUOTE_DEPTH = 2;
const MAX_INLINE_DEPTH = 3;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Token =
  | { kind: "line"; text: string }
  | { kind: "fence"; lang: string; text: string; open: boolean };

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLANK_RE = /^[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+([\s\S]*?)(?:[ \t]+#+)?[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+([\s\S]*))?$/;
const DELIM_CELL_RE = /^:?-+:?$/;
const PARTIAL_DELIM_RE = /^[ \t]*\|[ \t:|-]*$/;
const INLINE_CODE_RE = /(`+)[^\n]*?\1/g;

export function parseBlocks(src: string, options: ParseOptions = {}): MdBlock[] {
  return parseAt(src.replace(/\r\n?/g, "\n").replace(/\n$/, ""), 0, Boolean(options.streaming));
}

function parseAt(src: string, depth: number, streaming: boolean): MdBlock[] {
  return parseTokens(tokenize(src, streaming), depth, streaming);
}

type Run = { fence: false; lines: string[] } | { fence: true; lang: string; text: string; open: boolean };

// Fenced code first: nothing inside a fence is math, markdown, or a citation.
function splitFences(lines: string[]): Run[] {
  const runs: Run[] = [];
  let plain: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i]!);
    if (!open) {
      plain.push(lines[i]!);
      i++;
      continue;
    }
    if (plain.length) runs.push({ fence: false, lines: plain });
    plain = [];
    const indent = open[1]!.length;
    const marker = open[2]!;
    const body: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const close = FENCE_CLOSE_RE.exec(lines[i]!);
      if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
        closed = true;
        i++;
        break;
      }
      body.push(stripIndent(lines[i]!, indent));
      i++;
    }
    runs.push({ fence: true, lang: open[3] ?? "", text: body.join("\n"), open: !closed });
  }
  if (plain.length) runs.push({ fence: false, lines: plain });
  return runs;
}

function tokenize(src: string, streaming: boolean): Token[] {
  const runs = splitFences(src.split("\n"));
  const tokens: Token[] = [];
  runs.forEach((run, index) => {
    if (run.fence) {
      tokens.push({ kind: "fence", lang: run.lang, text: run.text, open: run.open });
      return;
    }
    const allowOpen = streaming && index === runs.length - 1;
    for (const text of logicalLines(run.lines, allowOpen)) tokens.push({ kind: "line", text });
  });
  return tokens;
}

// Join physical lines whose separating newline sits inside a math run, so a
// multi-line \[ … \] stays one unit for the block parser.
function logicalLines(lines: string[], allowOpen: boolean): string[] {
  const text = lines.join("\n");
  // Code spans can hold a literal "\[" or "$$" that isn't math.
  const masked = text.replace(INLINE_CODE_RE, (match) => " ".repeat(match.length));
  const ranges = mathRanges(masked);
  const openAt = allowOpen ? openMathStart(masked) : -1;
  const out: string[] = [];
  let buffer = lines[0] ?? "";
  let newlineAt = buffer.length;
  let r = 0;
  for (let k = 1; k < lines.length; k++) {
    while (r < ranges.length && ranges[r]!.end <= newlineAt) r++;
    const insideMath = r < ranges.length && ranges[r]!.start < newlineAt;
    const insideOpen = openAt !== -1 && newlineAt > openAt;
    if (insideMath || insideOpen) {
      buffer += `\n${lines[k]}`;
    } else {
      out.push(buffer);
      buffer = lines[k]!;
    }
    newlineAt += 1 + lines[k]!.length;
  }
  out.push(buffer);
  return out;
}

function parseTokens(tokens: Token[], depth: number, streaming: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === "fence") {
      blocks.push({ type: "code", lang: token.lang, text: token.text, open: token.open });
      i++;
      continue;
    }
    const text = token.text;
    if (BLANK_RE.test(text)) {
      i++;
      continue;
    }
    if (HR_RE.test(text)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const heading = HEADING_RE.exec(text);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE_RE.test(text)) {
      const inner: string[] = [];
      let j = i;
      while (j < tokens.length) {
        const next = tokens[j]!;
        if (next.kind !== "line" || !QUOTE_RE.test(next.text)) break;
        inner.push(next.text.split("\n").map(stripQuoteMarker).join("\n"));
        j++;
      }
      blocks.push({ type: "quote", blocks: parseAt(inner.join("\n"), depth + 1, streaming && j === tokens.length) });
      i = j;
      continue;
    }
    const table = tableAt(tokens, i, streaming);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    if (ITEM_RE.test(text)) {
      const list = listAt(tokens, i, depth, streaming);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    const lines = [text.trimStart()];
    let j = i + 1;
    while (j < tokens.length) {
      const next = tokens[j]!;
      if (next.kind !== "line" || BLANK_RE.test(next.text) || startsBlock(tokens, j, depth, streaming)) break;
      lines.push(next.text.trimStart());
      j++;
    }
    blocks.push({ type: "paragraph", text: lines.join("\n") });
    i = j;
  }
  return blocks;
}

function startsBlock(tokens: Token[], i: number, depth: number, streaming: boolean): boolean {
  const token = tokens[i]!;
  if (token.kind === "fence") return true;
  const text = token.text;
  return (
    HR_RE.test(text) ||
    HEADING_RE.test(text) ||
    (depth < MAX_QUOTE_DEPTH && QUOTE_RE.test(text)) ||
    ITEM_RE.test(text) ||
    tableAt(tokens, i, streaming) !== null
  );
}

// ---- Lists -----------------------------------------------------------------

interface ItemMatch {
  indent: number;
  ordered: boolean;
  number: number;
  content: string;
}

function matchItem(text: string): ItemMatch | null {
  const match = ITEM_RE.exec(text);
  if (!match) return null;
  const marker = match[2]!;
  const ordered = /\d/.test(marker[0]!);
  return {
    indent: indentWidth(match[1]!),
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 1,
    content: match[3] ?? "",
  };
}

interface DraftItem {
  lines: string[];
  child: { ordered: boolean; start: number; items: string[][] } | null;
}

function listAt(
  tokens: Token[],
  start: number,
  depth: number,
  streaming: boolean,
): { block: MdBlock; next: number } {
  const first = matchItem((tokens[start] as { text: string }).text)!;
  const base = first.indent;
  const items: DraftItem[] = [{ lines: [first.content], child: null }];
  let afterBlank = false;
  let i = start + 1;

  const lastLines = (): string[] => {
    const item = items[items.length - 1]!;
    return item.child ? item.child.items[item.child.items.length - 1]! : item.lines;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind !== "line") break;
    if (BLANK_RE.test(token.text)) {
      // A blank line only ends the list if what follows isn't more of it —
      // models often write "1. a\n\n2. b", which is still one list.
      let k = i + 1;
      while (k < tokens.length && tokens[k]!.kind === "line" && BLANK_RE.test((tokens[k] as { text: string }).text)) k++;
      const next = tokens[k];
      if (!next || next.kind !== "line") break;
      const nextItem = matchItem(next.text);
      const continues = nextItem
        ? nextItem.indent >= base + 2 || nextItem.ordered === first.ordered
        : indentWidth(leadingWhitespace(next.text)) >= base + 2;
      if (!continues) break;
      afterBlank = true;
      i = k;
      continue;
    }
    const item = matchItem(token.text);
    if (item && item.indent < base + 2) {
      if (item.ordered !== first.ordered) break;
      items.push({ lines: [item.content], child: null });
    } else if (item) {
      // One nesting level; anything deeper flattens into it.
      const parent = items[items.length - 1]!;
      if (!parent.child) parent.child = { ordered: item.ordered, start: item.number, items: [] };
      parent.child.items.push([item.content]);
    } else if (indentWidth(leadingWhitespace(token.text)) >= base + 2) {
      const lines = lastLines();
      if (afterBlank) lines.push("");
      lines.push(token.text.trimStart());
    } else if (!afterBlank && !startsBlock(tokens, i, depth, streaming)) {
      // Lazy continuation: an unindented line straight after an item.
      lastLines().push(token.text.trimStart());
    } else {
      break;
    }
    afterBlank = false;
    i++;
  }

  return {
    block: {
      type: "list",
      ordered: first.ordered,
      start: first.number,
      items: items.map((item) => ({
        text: item.lines.join("\n"),
        children: item.child
          ? [
              {
                type: "list",
                ordered: item.child.ordered,
                start: item.child.start,
                items: item.child.items.map((lines) => ({ text: lines.join("\n"), children: [] })),
              },
            ]
          : [],
      })),
    },
    next: i,
  };
}

// ---- Tables ----------------------------------------------------------------

interface RowCells {
  cells: string[];
  /** Saw at least one cell-separating pipe (outside code, math, and \|). */
  piped: boolean;
}

// Split a table row on pipes that aren't inside inline code, math, or \|.
function splitRow(line: string): RowCells {
  let s = line.trim();
  let piped = false;
  if (s.startsWith("|")) {
    s = s.slice(1);
    piped = true;
  }
  if (s.endsWith("|") && !s.endsWith("\\|")) {
    s = s.slice(0, -1);
    piped = true;
  }
  const cells: string[] = [];
  let cellStart = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\") {
      const pair = s.slice(i, i + 2);
      if (pair === "\\(" || pair === "\\[") {
        const close = s.indexOf(pair === "\\(" ? "\\)" : "\\]", i + 2);
        if (close !== -1) {
          i = close + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (ch === "$" && s[i + 1] === "$") {
      const close = s.indexOf("$$", i + 2);
      i = close === -1 ? i + 2 : close + 2;
      continue;
    }
    if (ch === "`") {
      const run = backtickRun(s, i);
      const close = findBacktickRun(s, i + run, run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === "|") {
      cells.push(s.slice(cellStart, i).trim());
      cellStart = i + 1;
      piped = true;
    }
    i++;
  }
  cells.push(s.slice(cellStart).trim());
  return { cells, piped };
}

function delimiterAlign(text: string): MdAlign[] | null {
  if (!text.includes("|")) return null;
  const { cells } = splitRow(text);
  if (!cells.length || !cells.every((cell) => DELIM_CELL_RE.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

// A line that already reads as a header row: | a | b |
function looksLikeHeader(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitRow(trimmed).cells.length >= 2;
}

function tableAt(tokens: Token[], i: number, streaming: boolean): { block: MdBlock; next: number } | null {
  const head = tokens[i];
  if (!head || head.kind !== "line" || head.text.includes("\n")) return null;
  const header = splitRow(head.text);
  if (!header.piped) return null;
  const delim = tokens[i + 1];
  const align = delim && delim.kind === "line" ? delimiterAlign(delim.text) : null;

  if (align && align.length === header.cells.length) {
    const rows: string[][] = [];
    let j = i + 2;
    while (j < tokens.length) {
      const row = tokens[j]!;
      if (row.kind !== "line" || BLANK_RE.test(row.text) || row.text.includes("\n")) break;
      if (HEADING_RE.test(row.text) || QUOTE_RE.test(row.text)) break;
      const split = splitRow(row.text);
      if (!split.piped) break;
      rows.push(fitRow(split.cells, header.cells.length));
      j++;
    }
    return { block: { type: "table", align, header: header.cells, rows }, next: j };
  }

  // Mid-answer: show the header as soon as it's written, and keep showing it
  // while the delimiter row is half-typed, instead of flashing raw pipes.
  if (!streaming || !looksLikeHeader(head.text)) return null;
  const isLast = i === tokens.length - 1;
  const partialDelimLast =
    i + 1 === tokens.length - 1 && delim?.kind === "line" && PARTIAL_DELIM_RE.test(delim.text);
  if (!isLast && !partialDelimLast) return null;
  return {
    block: { type: "table", align: header.cells.map(() => null), header: header.cells, rows: [] },
    next: tokens.length,
  };
}

function fitRow(cells: string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) row.push("");
  return row;
}

// ---- Small helpers ---------------------------------------------------------

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)![0];
}

function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === "\t" ? 4 : 1;
  return width;
}

function stripIndent(line: string, count: number): string {
  let i = 0;
  while (i < count && line[i] === " ") i++;
  return line.slice(i);
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^ {0,3}> ?/, "");
}

function backtickRun(s: string, at: number): number {
  let n = 0;
  while (s[at + n] === "`") n++;
  return n;
}

// Index of the next run of exactly `length` backticks at or after `from`.
function findBacktickRun(s: string, from: number, length: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === "`") {
      const run = backtickRun(s, i);
      if (run === length) return i;
      i += run;
    } else {
      i++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

type Atom = { kind: "math"; tex: string; display: boolean } | { kind: "code"; text: string } | { kind: "char"; text: string };

// Atoms are swapped for private-use characters while emphasis is matched, so
// the emphasis patterns can't see inside them.
const PLACEHOLDER_BASE = 0xe000;
const PLACEHOLDER_LIMIT = 0xf8ff - PLACEHOLDER_BASE;
const PLACEHOLDER_RE = /[\uE000-\uF8FF]/g;
const HAS_PLACEHOLDER_RE = /[\uE000-\uF8FF]/;
const ESCAPABLE = new Set(["*", "_", "`", "|", "#"]);
const MATH_CLOSER: Record<string, string> = { "\\(": "\\)", "\\[": "\\]", $$: "$$" };

const STRONG_STAR_RE = /\*\*(?![\s*])([\s\S]*?[^\s*])\*\*/g;
const STRONG_UNDER_RE = /(?<![\p{L}\p{N}_])__(?![\s_])([\s\S]*?[^\s_])__(?![\p{L}\p{N}_])/gu;
const EM_STAR_RE = /\*([^\s*](?:[^*]*[^\s*])?)\*/g;
// Word boundaries on both sides, so snake_case_names stay plain text.
const EM_UNDER_RE = /(?<![\p{L}\p{N}_])_([^\s_](?:[^_]*[^\s_])?)_(?![\p{L}\p{N}_])/gu;
const LINK_RE = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/i;

export function parseInline(text: string): MdInline[] {
  const { masked, atoms } = maskAtoms(text.replace(PLACEHOLDER_RE, ""));
  return mergeText(parseSpans(masked, 0, atoms));
}

function maskAtoms(text: string): { masked: string; atoms: Atom[] } {
  const atoms: Atom[] = [];
  let masked = "";
  // Like splitMath: once an opener has no closer, nothing after it is math.
  let mathOn = true;
  let i = 0;

  const place = (atom: Atom, raw: string) => {
    if (atoms.length > PLACEHOLDER_LIMIT) {
      masked += raw;
      return;
    }
    masked += String.fromCharCode(PLACEHOLDER_BASE + atoms.length);
    atoms.push(atom);
  };

  while (i < text.length) {
    const ch = text[i]!;
    const opener =
      mathOn && ((ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) || (ch === "$" && text[i + 1] === "$"))
        ? text.slice(i, i + 2)
        : null;
    if (opener) {
      const close = text.indexOf(MATH_CLOSER[opener]!, i + 2);
      if (close === -1) {
        mathOn = false;
        masked += opener;
        i += 2;
        continue;
      }
      const tex = text.slice(i + 2, close).trim();
      if (tex) place({ kind: "math", tex, display: opener !== "\\(" }, text.slice(i, close + 2));
      else masked += text.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    if (ch === "\\" && ESCAPABLE.has(text[i + 1] ?? "")) {
      place({ kind: "char", text: text[i + 1]! }, text.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = backtickRun(text, i);
      const close = findBacktickRun(text, i + run, run);
      if (close === -1) {
        masked += text.slice(i, i + run);
        i += run;
        continue;
      }
      let body = text.slice(i + run, close);
      if (body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
      place({ kind: "code", text: body }, text.slice(i, close + run));
      i = close + run;
      continue;
    }
    masked += ch;
    i++;
  }
  return { masked, atoms };
}

interface SpanHit {
  index: number;
  end: number;
  kind: "strong" | "em" | "link";
  inner: string;
  href?: string;
}

function firstMatch(re: RegExp, s: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(s);
}

function nextSpan(s: string, from: number): SpanHit | null {
  let best: SpanHit | null = null;
  // Order is the tie-break at the same index: bold before italic.
  for (const [re, kind] of [
    [STRONG_STAR_RE, "strong"],
    [STRONG_UNDER_RE, "strong"],
    [EM_STAR_RE, "em"],
    [EM_UNDER_RE, "em"],
  ] as const) {
    const match = firstMatch(re, s, from);
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, end: match.index + match[0].length, kind, inner: match[1]! };
    }
  }
  let link = firstMatch(LINK_RE, s, from);
  while (link && (!SAFE_HREF_RE.test(link[2]!) || HAS_PLACEHOLDER_RE.test(link[2]!))) {
    link = firstMatch(LINK_RE, s, link.index + 1);
  }
  if (link && (!best || link.index < best.index)) {
    best = { index: link.index, end: link.index + link[0].length, kind: "link", inner: link[1]!, href: link[2]! };
  }
  return best;
}

function parseSpans(s: string, depth: number, atoms: Atom[]): MdInline[] {
  const out: MdInline[] = [];
  let pos = 0;
  while (depth < MAX_INLINE_DEPTH && pos < s.length) {
    const hit = nextSpan(s, pos);
    if (!hit) break;
    if (hit.index > pos) out.push(...expandText(s.slice(pos, hit.index), atoms));
    const children = mergeText(parseSpans(hit.inner, depth + 1, atoms));
    out.push(hit.kind === "link" ? { type: "link", href: hit.href!, children } : { type: hit.kind, children });
    pos = hit.end;
  }
  if (pos < s.length) out.push(...expandText(s.slice(pos), atoms));
  return out;
}

// Restore atoms in a plain run, then split out [n] citations and line breaks.
function expandText(s: string, atoms: Atom[]): MdInline[] {
  const out: MdInline[] = [];
  let plain = "";
  const flushPlain = () => {
    if (!plain) return;
    for (const segment of segmentCitations(plain)) {
      if (segment.kind === "cite") {
        out.push({ type: "cite", n: segment.n });
        continue;
      }
      segment.text.split("\n").forEach((line, index) => {
        if (index > 0) out.push({ type: "break" });
        if (line) out.push({ type: "text", text: line });
      });
    }
    plain = "";
  };
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const atom = code >= PLACEHOLDER_BASE && code <= 0xf8ff ? atoms[code - PLACEHOLDER_BASE] : undefined;
    if (!atom) {
      plain += ch;
      continue;
    }
    if (atom.kind === "char") {
      plain += atom.text;
      continue;
    }
    flushPlain();
    out.push(atom.kind === "math" ? { type: "math", tex: atom.tex, display: atom.display } : { type: "code", text: atom.text });
  }
  flushPlain();
  return out;
}

function mergeText(nodes: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}
