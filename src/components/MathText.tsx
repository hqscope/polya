import { Fragment, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { splitMath } from "@/lib/math-text";

// Typeset LaTeX from course text and tutor answers. Both are untrusted, so
// KaTeX runs with trust off (no \href, \url, \htmlClass…), never throws (a
// malformed expression renders in red instead of breaking the message), and
// caps macro expansion and sizes. Rendered HTML is cached because a streaming
// answer re-renders every math run on every delta.

const MAX_TEX_CHARS = 2_000;
const CACHE_LIMIT = 500;
const cache = new Map<string, string>();

function renderTex(tex: string, display: boolean): string {
  const cacheKey = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    maxExpand: 200,
    maxSize: 20,
    output: "htmlAndMathml",
  });
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, html);
  return html;
}

export function MathSpan({ tex, display = false }: { tex: string; display?: boolean }) {
  if (tex.length > MAX_TEX_CHARS) {
    return <span className="wrap-anywhere">{tex}</span>;
  }
  return (
    <span
      className={display ? "block max-w-full overflow-x-auto overflow-y-hidden" : undefined}
      dangerouslySetInnerHTML={{ __html: renderTex(tex, display) }}
    />
  );
}

interface Props {
  text: string;
  /** Renders a plain-text run (citations, emphasis). Defaults to the raw string. */
  renderText?: (text: string) => ReactNode;
}

/** Text with \( … \), \[ … \] and $$ … $$ runs typeset as math. */
export default function MathText({ text, renderText }: Props) {
  return (
    <>
      {splitMath(text).map((segment, i) =>
        segment.kind === "math" ? (
          <MathSpan key={i} tex={segment.tex} display={segment.display} />
        ) : (
          <Fragment key={i}>{renderText ? renderText(segment.text) : segment.text}</Fragment>
        ),
      )}
    </>
  );
}
