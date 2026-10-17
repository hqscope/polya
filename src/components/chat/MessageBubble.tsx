"use client";

import type { TutorSource } from "@/lib/sse";
import RichText from "@/components/chat/RichText";
import MathText from "@/components/MathText";

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
          <MathText text={message.content} />
        </div>
      </div>
    );
  }

  const handleCite = onCiteClick ? (n: number) => onCiteClick(messageIndex, n) : undefined;

  return (
    <div className="min-w-0 animate-fade-up text-[14px] leading-[1.75] text-ink wrap-break-word">
      <RichText text={message.content} onCite={handleCite} activeCitation={activeCitation} caret={caret} />
    </div>
  );
}
