"use client";

import type { ReactNode } from "react";
import { segmentCitations } from "@/lib/citations";
import type { TutorSource } from "@/lib/sse";
import CitationPill from "@/components/chat/CitationPill";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // The numbered evidence behind THIS answer — [n] pills resolve against it,
  // so citations stay correct across answers and on resumed conversations.
  sources?: TutorSource[];
}

interface Props {
  message: ChatMessage;
  /** Index of this message in the conversation — citation clicks carry it. */
  messageIndex: number;
  onCiteClick?: (messageIndex: number, n: number) => void;
  activeCitation?: number | null;
  /** Show a blinking caret after the text while it streams in. */
  caret?: boolean;
}

// Parse a plain text run into nodes with inline markdown emphasis:
// **bold** / __bold__, *italic* / _italic_, and `code`.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Bold (**/__) is tried before italic (*/_) so the longer marker wins.
  const regex = /\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*]+?)\*|_([^_]+?)_|`([^`]+?)`/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined || match[2] !== undefined) {
      nodes.push(<strong key={key++}>{match[1] ?? match[2]}</strong>);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      nodes.push(<em key={key++}>{match[3] ?? match[4]}</em>);
    } else {
      nodes.push(
        <code key={key++} className="rounded bg-line-soft px-1 py-px text-[0.85em] wrap-anywhere">
          {match[5]}
        </code>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Render assistant prose with inline [n] pills; preserve paragraph breaks.
function renderAssistant(
  content: string,
  onCiteClick?: (n: number) => void,
  active?: number | null,
  caret?: boolean,
) {
  const paragraphs = content.split(/\n{2,}/);
  return paragraphs.map((paragraph, pIdx) => (
    <p key={pIdx} className="m-0 text-pretty">
      {segmentCitations(paragraph).map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{renderInline(seg.text)}</span>
        ) : (
          <CitationPill key={i} n={seg.n} active={active === seg.n} onClick={onCiteClick} />
        ),
      )}
      {caret && pIdx === paragraphs.length - 1 ? (
        <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-caret-blink rounded-[2px] bg-accent align-middle" />
      ) : null}
    </p>
  ));
}

export default function MessageBubble({
  message,
  messageIndex,
  onCiteClick,
  activeCitation,
  caret,
}: Props) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-[10px] bg-line-soft px-[13px] py-[9px] text-[13.5px] leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {message.content}
        </div>
      </div>
    );
  }

  const handleCite = onCiteClick ? (n: number) => onCiteClick(messageIndex, n) : undefined;

  return (
    <div className="flex min-w-0 animate-fade-up flex-col gap-2.5 text-[14px] leading-[1.75] text-ink wrap-break-word">
      {renderAssistant(message.content, handleCite, activeCitation, caret)}
    </div>
  );
}
