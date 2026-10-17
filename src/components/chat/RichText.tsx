"use client";

import { Fragment, useMemo } from "react";

import CitationPill from "@/components/chat/CitationPill";
import { MathSpan } from "@/components/MathText";
import { parseBlocks, parseInline, type MdAlign, type MdBlock, type MdInline } from "@/lib/markdown";

interface Props {
  text: string;
  onCite?: (n: number) => void;
  activeCitation?: number | null;
  /** Show a blinking caret after the last word while the text streams in. */
  caret?: boolean;
  /** The text is still arriving (partial tables, open math). Defaults to `caret`. */
  streaming?: boolean;
  className?: string;
}

interface Ctx {
  onCite?: (n: number) => void;
  activeCitation?: number | null;
}

const ALIGN_CLASS: Record<Exclude<MdAlign, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-caret-blink rounded-[2px] bg-accent align-middle" />
  );
}

function InlineNodes({ nodes, ctx }: { nodes: MdInline[]; ctx: Ctx }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "text":
            return <Fragment key={i}>{node.text}</Fragment>;
          case "break":
            return <br key={i} />;
          case "strong":
            return (
              <strong key={i}>
                <InlineNodes nodes={node.children} ctx={ctx} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <InlineNodes nodes={node.children} ctx={ctx} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-line-soft px-1 py-px text-[0.85em] wrap-anywhere">
                {node.text}
              </code>
            );
          case "math":
            return <MathSpan key={i} tex={node.tex} display={node.display} />;
          case "cite":
            return <CitationPill key={i} n={node.n} active={ctx.activeCitation === node.n} onClick={ctx.onCite} />;
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-line underline-offset-2 hover:decoration-accent"
              >
                <InlineNodes nodes={node.children} ctx={ctx} />
              </a>
            );
        }
      })}
    </>
  );
}

function Inline({ text, ctx, caret }: { text: string; ctx: Ctx; caret?: boolean }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return (
    <>
      <InlineNodes nodes={nodes} ctx={ctx} />
      {caret ? <Caret /> : null}
    </>
  );
}

function ListView({ block, ctx, caret }: { block: Extract<MdBlock, { type: "list" }>; ctx: Ctx; caret?: boolean }) {
  const items = block.items.map((item, i) => {
    const last = i === block.items.length - 1;
    const hasChildren = item.children.length > 0;
    return (
      <li key={i} className="pl-0.5">
        <Inline text={item.text} ctx={ctx} caret={caret && last && !hasChildren} />
        {item.children.map((child, j) => (
          <BlockView
            key={j}
            block={child}
            ctx={ctx}
            caret={caret && last && j === item.children.length - 1}
            nested
          />
        ))}
      </li>
    );
  });
  const className = `m-0 flex flex-col gap-1 pl-5 marker:text-ink3 ${block.ordered ? "list-decimal" : "list-disc"}`;
  return block.ordered ? (
    <ol className={className} start={block.start}>
      {items}
    </ol>
  ) : (
    <ul className={className}>{items}</ul>
  );
}

function TableView({ block, ctx, caret }: { block: Extract<MdBlock, { type: "table" }>; ctx: Ctx; caret?: boolean }) {
  const lastRow = block.rows.length - 1;
  const lastCol = block.header.length - 1;
  const align = (col: number) => ALIGN_CLASS[block.align[col] ?? "left"];
  return (
    <div
      role="region"
      aria-label="Table"
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-accent"
    >
      <table className="w-full border-collapse text-[13px] leading-normal">
        <thead className="bg-rail">
          <tr>
            {block.header.map((cell, col) => (
              <th key={col} scope="col" className={`border-b border-line px-2.5 py-1.5 font-semibold ${align(col)}`}>
                <Inline text={cell} ctx={ctx} caret={caret && lastRow === -1 && col === lastCol} />
              </th>
            ))}
          </tr>
        </thead>
        {block.rows.length ? (
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r} className="border-t border-line-soft first:border-t-0">
                {row.map((cell, col) => (
                  <td key={col} className={`px-2.5 py-1.5 align-top ${align(col)}`}>
                    <Inline text={cell} ctx={ctx} caret={caret && r === lastRow && col === lastCol} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

function BlockView({ block, ctx, caret, nested }: { block: MdBlock; ctx: Ctx; caret?: boolean; nested?: boolean }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="m-0 text-pretty">
          <Inline text={block.text} ctx={ctx} caret={caret} />
        </p>
      );
    case "heading":
      return block.level <= 2 ? (
        <h3 className="m-0 mt-1 text-[15px] leading-snug text-ink">
          <Inline text={block.text} ctx={ctx} caret={caret} />
        </h3>
      ) : (
        <h4 className="m-0 mt-1 text-[13.5px] leading-snug font-semibold text-ink">
          <Inline text={block.text} ctx={ctx} caret={caret} />
        </h4>
      );
    case "list":
      return (
        <div className={nested ? "mt-1" : undefined}>
          <ListView block={block} ctx={ctx} caret={caret} />
        </div>
      );
    case "table":
      return <TableView block={block} ctx={ctx} caret={caret} />;
    case "code":
      return (
        <pre
          role="region"
          aria-label="Code"
          tabIndex={0}
          className="m-0 max-w-full overflow-x-auto rounded-lg bg-rail px-3 py-2 font-mono text-[12.5px] leading-relaxed focus-visible:outline-2 focus-visible:outline-accent"
        >
          <code>{block.text}</code>
          {caret ? <Caret /> : null}
        </pre>
      );
    case "quote":
      return (
        <blockquote className="m-0 flex flex-col gap-2 border-l-2 border-line pl-3 text-ink2">
          {block.blocks.map((inner, i) => (
            <BlockView key={i} block={inner} ctx={ctx} caret={caret && i === block.blocks.length - 1} />
          ))}
        </blockquote>
      );
    case "hr":
      return (
        <>
          <hr className="my-1 border-line" />
          {caret ? <Caret /> : null}
        </>
      );
  }
}

// Assistant prose: headings, lists, tables, code, quotes, typeset math, and
// [n] citation pills. Text is always rendered as text — never as HTML.
export default function RichText({ text, onCite, activeCitation, caret, streaming, className }: Props) {
  const live = streaming ?? Boolean(caret);
  const blocks = useMemo(() => parseBlocks(text, { streaming: live }), [text, live]);
  const ctx: Ctx = { onCite, activeCitation };
  return (
    <div className={className ?? "flex min-w-0 flex-col gap-2.5"}>
      {blocks.length === 0 && caret ? (
        <p className="m-0">
          <Caret />
        </p>
      ) : null}
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} ctx={ctx} caret={caret && i === blocks.length - 1} />
      ))}
    </div>
  );
}
