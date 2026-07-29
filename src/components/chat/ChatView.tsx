"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { streamTutor, type MasteryVerdict, type TutorSource } from "@/lib/sse";
import { track } from "@/lib/track";
import MessageBubble, { type ChatMessage } from "@/components/chat/MessageBubble";
import SourceRail from "@/components/chat/SourceRail";
import SourcePanel from "@/components/viewer/SourcePanel";

interface Props {
  courseId: string;
  courseName: string;
  initialPolicyMode: string;
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
}

const POLICY_CHIP: Record<string, [string, string]> = {
  open: ["Open", "full answers on request"],
  guided: ["Guided", "hints first"],
  practice: ["Practice", "commit before reveal"],
  review: ["Review", "full solutions"],
};

const VERDICT_BADGE: Record<MasteryVerdict, { label: string; className: string }> = {
  pass: { label: "You've got it", className: "bg-accent-soft text-accent-ink" },
  partial: { label: "Close — one gap", className: "bg-amber-soft text-amber" },
  fail: { label: "Not yet — keep going", className: "bg-amber-soft text-amber" },
};

export default function ChatView({
  courseId,
  courseName,
  initialPolicyMode,
  initialConversationId,
  initialMessages = [],
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState("");
  // Sources for the answer currently streaming in (they arrive first).
  const [pendingSources, setPendingSources] = useState<TutorSource[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [policyMode, setPolicyMode] = useState(initialPolicyMode);
  // Which message's citation is highlighted — [2] in one answer must not
  // co-highlight [2] in another.
  const [activeCitation, setActiveCitation] = useState<{
    messageIndex: number;
    n: number;
  } | null>(null);
  // Which message's sources the rail shows; null = the latest answer.
  const [railIndex, setRailIndex] = useState<number | null>(null);
  const [viewing, setViewing] = useState<TutorSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  // An open mastery check: the next send is the student's independent answer.
  const [masteryCheckId, setMasteryCheckId] = useState<string | null>(null);
  // Verdict badges keyed by the assistant message index they belong to.
  const [verdicts, setVerdicts] = useState<Record<number, MasteryVerdict>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // Index of the newest assistant message that carries sources.
  let latestSourcedIndex: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant" && (messages[i]!.sources?.length ?? 0) > 0) {
      latestSourcedIndex = i;
      break;
    }
  }

  // messageIndex === messages.length refers to the answer still streaming.
  const sourcesForMessage = useCallback(
    (messageIndex: number): TutorSource[] => {
      if (messageIndex === messages.length) return pendingSources;
      return messages[messageIndex]?.sources ?? [];
    },
    [messages, pendingSources],
  );

  // Clicking a citation [n] resolves it against ITS message's sources,
  // highlights it, points the rail at that message, and opens the source.
  const openCitation = useCallback(
    (messageIndex: number, n: number) => {
      const match = sourcesForMessage(messageIndex).find((source) => source.n === n);
      if (!match) return;
      setActiveCitation({ messageIndex, n });
      setRailIndex(messageIndex === messages.length ? null : messageIndex);
      setViewing(match);
      track("citation_opened", courseId, { n });
    },
    [courseId, messages.length, sourcesForMessage],
  );

  // What the rail displays: the streaming answer's sources while streaming,
  // otherwise the selected (or latest) answer's sources.
  const railMessageIndex =
    streaming || busy ? messages.length : (railIndex ?? latestSourcedIndex ?? messages.length);
  const railSources = sourcesForMessage(railMessageIndex);
  const railIsEarlier =
    railMessageIndex !== messages.length &&
    latestSourcedIndex !== null &&
    railMessageIndex !== latestSourcedIndex;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const send = useCallback(
    async (
      text: string,
      attempt = false,
      mastery?: { phase: "start"; concept: string } | { phase: "answer"; check_id: string },
    ) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      if (messages.length === 0) track("first_question_asked", courseId);
      if (!conversationId) track("conversation_started", courseId);
      if (mastery?.phase === "start") track("mastery_check_started", courseId);

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setInput("");
      setStreaming("");
      setBusy(true);
      setPendingSources([]);
      setRailIndex(null);
      let assembled = "";
      let received: TutorSource[] = [];
      let verdict: MasteryVerdict | null = null;

      await streamTutor(
        { course_id: courseId, message: trimmed, conversation_id: conversationId, attempt, mastery },
        {
          onSources: (payload) => {
            received = payload.sources;
            setPendingSources(payload.sources);
            setConversationId(payload.conversation_id);
            setPolicyMode(payload.policy_mode);
            setActiveCitation(null);
          },
          onDelta: (delta) => {
            assembled += delta;
            setStreaming(assembled);
          },
          onMastery: (payload) => {
            verdict = payload.verdict;
          },
          onDone: (payload) => {
            setMessages((prev) => {
              if (verdict) {
                setVerdicts((v) => ({ ...v, [prev.length]: verdict! }));
              }
              return [...prev, { role: "assistant", content: assembled, sources: received }];
            });
            if (mastery?.phase === "start" && payload.mastery_check_id) {
              setMasteryCheckId(payload.mastery_check_id);
            }
            if (mastery?.phase === "answer" && verdict) {
              setMasteryCheckId(null);
            }
            setStreaming("");
            setPendingSources([]);
            setBusy(false);
          },
          onError: (message) => {
            setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${message}` }]);
            setStreaming("");
            setPendingSources([]);
            setBusy(false);
          },
        },
      );
    },
    [busy, courseId, conversationId, messages.length],
  );

  // "Check yourself": the tutor poses one related question to try unaided.
  const startMasteryCheck = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const concept = (lastUserMessage?.content ?? courseName).slice(0, 80);
    void send("Give me one to try on my own.", false, { phase: "start", concept });
  }, [messages, courseName, send]);

  const assistantTurns = messages.filter((m) => m.role === "assistant").length;
  const answeringCheck = masteryCheckId !== null;

  const [policyLabel, policyDesc] =
    POLICY_CHIP[policyMode] ?? POLICY_CHIP.guided;
  const materialsHref = `/app/courses/${courseId}/materials`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line px-[18px]">
        <Link href="/app" className="shrink-0 text-[13px] text-ink3 hover:text-ink">
          My courses
        </Link>
        <span className="text-[13px] text-ink3">/</span>
        <h1 className="m-0 truncate text-[13.5px] font-semibold tracking-[-0.01em]">
          {courseName}
        </h1>
        <Link
          href={materialsHref}
          title="Set for this course — see the materials page"
          className="shrink-0 rounded bg-accent-soft px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] text-accent-ink hover:text-accent-ink"
        >
          {policyLabel} · {policyDesc}
        </Link>
        <Link
          href={materialsHref}
          className="button-secondary ml-auto h-7 shrink-0 rounded-md px-[11px] text-[12.5px]"
        >
          Course materials
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-7 pt-[26px] pb-2.5"
          >
            <div className="mx-auto flex max-w-[660px] flex-col gap-[22px]">
              {messages.length === 0 && !streaming ? (
                <div className="flex flex-col items-center pt-16 text-center">
                  <p className="eyebrow">{courseName}</p>
                  <h2 className="mt-3 text-[19px]">What are you working on?</h2>
                  <p className="mt-2.5 max-w-sm text-[13px] leading-[1.65] text-ink2">
                    Ask about a concept, a reading, or a problem you&apos;re
                    stuck on. Polya answers from your course and works through
                    it with you.
                  </p>
                </div>
              ) : null}

              {messages.map((message, i) => (
                <div key={i} className="flex flex-col gap-2">
                  {verdicts[i] ? (
                    <span
                      className={`self-start rounded-md px-2 py-[3px] text-[11px] font-bold uppercase tracking-[0.06em] ${VERDICT_BADGE[verdicts[i]!].className}`}
                    >
                      {VERDICT_BADGE[verdicts[i]!].label}
                    </span>
                  ) : null}
                  <MessageBubble
                    message={message}
                    messageIndex={i}
                    onCiteClick={openCitation}
                    activeCitation={activeCitation?.messageIndex === i ? activeCitation.n : null}
                  />
                </div>
              ))}

              {busy && !streaming ? (
                <div className="flex items-center gap-[9px] text-[12.5px] text-ink3">
                  <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" />
                  Reading your course materials…
                </div>
              ) : null}

              {streaming ? (
                <MessageBubble
                  message={{ role: "assistant", content: streaming }}
                  messageIndex={messages.length}
                  onCiteClick={openCitation}
                  activeCitation={
                    activeCitation?.messageIndex === messages.length ? activeCitation.n : null
                  }
                  caret
                />
              ) : null}
            </div>
          </div>

          <div className="shrink-0 px-7 pt-2 pb-[18px]">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(
                  input,
                  false,
                  answeringCheck ? { phase: "answer", check_id: masteryCheckId! } : undefined,
                );
              }}
              className="mx-auto flex max-w-[660px] flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-2.5 py-[9px] shadow-card"
            >
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(
                      input,
                      false,
                      answeringCheck ? { phase: "answer", check_id: masteryCheckId! } : undefined,
                    );
                  }
                }}
                rows={1}
                placeholder={
                  answeringCheck
                    ? "Try it on your own — then send your answer"
                    : "Ask about your course…"
                }
                className="max-h-[120px] min-h-[22px] resize-none border-none bg-transparent px-1 pt-1 text-[13.5px] leading-normal outline-none placeholder:text-ink3"
              />
              <div className="flex items-center gap-2.5">
                {answeringCheck ? (
                  <>
                    <span className="min-w-0 truncate text-[11px] font-semibold text-accent-ink">
                      Checking yourself — answer without Polya&apos;s help.
                    </span>
                    <button
                      type="button"
                      onClick={() => setMasteryCheckId(null)}
                      className="shrink-0 cursor-pointer text-[11px] text-ink3 underline hover:text-ink"
                    >
                      skip the check
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy || messages.length === 0}
                      onClick={() => void send("I'm stuck — can you give me the next step?", true)}
                      className="h-[26px] shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink disabled:cursor-default disabled:opacity-40"
                    >
                      I&apos;m stuck — next step
                    </button>
                    <button
                      type="button"
                      disabled={busy || assistantTurns < 2}
                      onClick={startMasteryCheck}
                      title="Polya gives you a related question to solve on your own"
                      className="h-[26px] shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink disabled:cursor-default disabled:opacity-40"
                    >
                      Check yourself
                    </button>
                    <span className="min-w-0 truncate text-[11px] text-ink3">
                      Hint → step → worked example. Polya won&apos;t just hand
                      you the answer.
                    </span>
                  </>
                )}
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="ml-auto h-[26px] w-7 shrink-0 cursor-pointer rounded-md bg-btn text-[13px] text-btn-text hover:bg-btn-hover disabled:cursor-default disabled:opacity-40"
                >
                  ↑
                </button>
              </div>
            </form>
          </div>
        </div>

        <aside className="hidden min-h-0 w-[320px] shrink-0 flex-col border-l border-line bg-rail lg:flex">
          {viewing ? (
            <SourcePanel
              source={viewing}
              onBack={() => {
                setViewing(null);
                setActiveCitation(null);
              }}
            />
          ) : (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft px-3.5">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">
                  Sources
                </span>
                {railIsEarlier ? (
                  <button
                    type="button"
                    onClick={() => setRailIndex(null)}
                    className="cursor-pointer text-[10.5px] text-ink3 underline hover:text-ink"
                    title="Showing sources from an earlier answer"
                  >
                    earlier answer · back to latest
                  </button>
                ) : null}
                {railSources.length > 0 ? (
                  <span className="ml-auto font-mono text-[10.5px] text-ink3">
                    {railSources.length} cited
                  </span>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2.5 pb-3.5">
                <SourceRail
                  sources={railSources}
                  activeCitation={
                    activeCitation?.messageIndex === railMessageIndex ? activeCitation.n : null
                  }
                  onSelect={(n) => openCitation(railMessageIndex, n)}
                />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
