"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { streamTutor, type MasteryVerdict, type TutorSource } from "@/lib/sse";
import { track } from "@/lib/track";
import MessageBubble, { type ChatMessage } from "@/components/chat/MessageBubble";
import SourceRail from "@/components/chat/SourceRail";
import SourcePanel from "@/components/viewer/SourcePanel";
import SourceSheet from "@/components/viewer/SourceSheet";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/lib/use-media-query";
import type { RecentConversation } from "@/lib/conversations";
import {
  describeChatFailure,
  POLYA_CHAT_RETRY,
  POLYA_CHAT_STOP,
  type ChatFailure,
} from "@/lib/chat-failure";

interface Props {
  courseId: string;
  courseName: string;
  initialPolicyMode: string;
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
  /** Shown on a fresh visit so a returning student can pick one back up. */
  recentConversations?: RecentConversation[];
}

const POLICY_CHIP: Record<string, [string, string]> = {
  open: ["Open", "full answers on request"],
  guided: ["Guided", "hints first"],
  practice: ["Practice", "commit before reveal"],
  review: ["Review", "full solutions"],
};

type MasteryTurn = { phase: "start"; concept: string } | { phase: "answer"; check_id: string };

// A turn that didn't get an answer, kept so Try Again can resend it as-is.
interface FailedTurn extends ChatFailure {
  text: string;
  attempt: boolean;
  mastery?: MasteryTurn;
}

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
  recentConversations = [],
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
  // Lecture Mode: what the student can see in the room right now.
  const [lectureOpen, setLectureOpen] = useState(false);
  const [boardText, setBoardText] = useState("");
  // An open mastery check: the next send is the student's independent answer.
  const [masteryCheckId, setMasteryCheckId] = useState<string | null>(null);
  // Verdict badges keyed by the assistant message index they belong to.
  const [verdicts, setVerdicts] = useState<Record<number, MasteryVerdict>>({});
  const [failedTurn, setFailedTurn] = useState<FailedTurn | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // From `lg` up an opened source fills the rail; below it, a bottom sheet.
  // Exactly one of them is mounted, so a source is only ever fetched once.
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);

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

  const closeViewer = useCallback(() => {
    setViewing(null);
    setActiveCitation(null);
  }, []);

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
  }, [messages, streaming, failedTurn]);

  const send = useCallback(
    async (text: string, attempt = false, mastery?: MasteryTurn) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      if (messages.length === 0) track("first_question_asked", courseId);
      if (!conversationId) track("conversation_started", courseId);
      if (mastery?.phase === "start") track("mastery_check_started", courseId);

      setFailedTurn(null);
      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setInput("");
      setStreaming("");
      setBusy(true);
      setPendingSources([]);
      setRailIndex(null);
      let assembled = "";
      let received: TutorSource[] = [];
      let verdict: MasteryVerdict | null = null;
      let settled = false;
      const controller = new AbortController();
      abortRef.current = controller;
      // A typed question goes back into the box if it doesn't get an answer;
      // the preset turns ("I'm stuck", "Check yourself") just get Try Again.
      const typed = !attempt && mastery?.phase !== "start";

      const finish = () => {
        settled = true;
        abortRef.current = null;
        setStreaming("");
        setPendingSources([]);
        setBusy(false);
      };

      // The turn didn't get an answer: take its bubble back out of the thread,
      // return a typed question to the box, and show the notice in the reply
      // slot. Partial text from a dropped answer is discarded with it.
      const giveBack = () => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && last.content === trimmed ? prev.slice(0, -1) : prev;
        });
        if (typed) setInput((current) => (current.trim() ? current : trimmed));
      };

      const fail = (code?: string, message?: string) => {
        giveBack();
        const failure = describeChatFailure({
          code,
          message,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
          questionInBox: typed,
        });
        setFailedTurn({ ...failure, text: trimmed, attempt, mastery });
        finish();
      };

      try {
        await streamTutor(
          {
            course_id: courseId,
            message: trimmed,
            conversation_id: conversationId,
            attempt,
            mastery,
            context: lectureOpen && boardText.trim() ? boardText.trim() : undefined,
          },
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
              if (settled) return;
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
              finish();
            },
            onError: (message, code) => {
              if (!settled) fail(code, message);
            },
          },
          controller.signal,
        );
        // The stream closed without finishing the answer.
        if (!settled) fail();
      } catch {
        if (settled) return;
        if (controller.signal.aborted) {
          // Stopped: keep what's arrived so far. Stopped before any text, the
          // turn is undone and a typed question goes back into the box.
          if (assembled.trim()) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: assembled, sources: received },
            ]);
          } else {
            giveBack();
          }
          finish();
          return;
        }
        fail();
      }
    },
    [busy, courseId, conversationId, messages.length, lectureOpen, boardText],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const retry = useCallback(() => {
    if (!failedTurn) return;
    void send(failedTurn.text, failedTurn.attempt, failedTurn.mastery);
  }, [failedTurn, send]);

  // Leaving the course mid-answer stops the stream.
  useEffect(() => () => abortRef.current?.abort(), []);

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
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line px-3 sm:px-[18px]">
        <Link href="/app" className="hidden shrink-0 text-[13px] text-ink3 hover:text-ink sm:inline">
          My courses
        </Link>
        <span className="hidden text-[13px] text-ink3 sm:inline">/</span>
        <h1 className="m-0 truncate text-[13.5px] font-semibold tracking-[-0.01em]">
          {courseName}
        </h1>
        <Link
          href={materialsHref}
          title="Set for this course — see the materials page"
          className="shrink-0 rounded bg-accent-soft px-2 py-[3px] text-[10px] font-[650] uppercase tracking-[0.07em] text-accent-ink hover:text-accent-ink"
        >
          {policyLabel}
          <span className="hidden sm:inline"> · {policyDesc}</span>
        </Link>
        <Link
          href={materialsHref}
          className="button-secondary ml-auto h-7 shrink-0 rounded-md px-[11px] text-[12.5px]"
        >
          <span className="sm:hidden">Materials</span>
          <span className="hidden sm:inline">Course materials</span>
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 pt-[26px] pb-2.5 sm:px-7"
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

                  {recentConversations.length > 0 ? (
                    <section
                      aria-labelledby="recent-conversations"
                      className="mt-9 flex w-full max-w-sm flex-col gap-2 text-left"
                    >
                      <h3 id="recent-conversations" className="eyebrow m-0 px-0.5 font-[650]">
                        Recent conversations
                      </h3>
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {recentConversations.map((conversation) => (
                          <li key={conversation.id}>
                            <Link
                              href={`/app/courses/${courseId}?c=${conversation.id}`}
                              className="flex items-baseline gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-card hover:border-accent"
                            >
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                                {conversation.title}
                              </span>
                              <span className="shrink-0 text-[11px] text-ink3">
                                {conversation.when}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
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

              {failedTurn && !busy ? (
                <div
                  role="status"
                  className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-rail px-3.5 py-3 sm:flex-row sm:items-center"
                >
                  <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.6] text-ink2">
                    {failedTurn.message}
                  </p>
                  {failedTurn.canRetry ? (
                    <button
                      type="button"
                      onClick={retry}
                      className="button-secondary h-8 shrink-0 rounded-md px-3 text-[12.5px]"
                    >
                      {POLYA_CHAT_RETRY}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="shrink-0 px-2 pt-2 pb-2 sm:px-7 sm:pb-[18px]">
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
              {lectureOpen ? (
                <div className="flex flex-col gap-1 rounded-md bg-accent-soft/40 px-1.5 pt-1.5 pb-1">
                  <label
                    htmlFor="board-text"
                    className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-ink"
                  >
                    On the board
                  </label>
                  <textarea
                    id="board-text"
                    value={boardText}
                    onChange={(event) => setBoardText(event.target.value)}
                    rows={2}
                    placeholder="The example being worked right now — type it or paste it from a photo."
                    className="max-h-[120px] resize-none border-none bg-transparent px-0.5 text-[12.5px] leading-normal outline-none placeholder:text-ink3"
                  />
                </div>
              ) : null}
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
                aria-label="Ask about your course"
                placeholder={
                  answeringCheck
                    ? "Try it on your own — then send your answer"
                    : "Ask about your course…"
                }
                className="max-h-[120px] min-h-[22px] resize-none border-none bg-transparent px-1 pt-1 text-[13.5px] leading-normal outline-none placeholder:text-ink3"
              />
              <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
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
                      onClick={() => setLectureOpen((open) => !open)}
                      aria-pressed={lectureOpen}
                      title="Answer from today's example, in your professor's own terms"
                      className={`h-[26px] shrink-0 cursor-pointer rounded-md border px-2.5 text-[12px] font-semibold ${
                        lectureOpen
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : "border-line text-ink2 hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
                      }`}
                    >
                      Lecture
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
                    <span className="hidden min-w-0 flex-1 truncate text-[11px] text-ink3 sm:block">
                      Hint → step → worked example. Polya won&apos;t just hand
                      you the answer.
                    </span>
                  </>
                )}
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="ml-auto flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink hover:border-ink3"
                  >
                    <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-ink" />
                    {POLYA_CHAT_STOP}
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Send"
                    className="ml-auto h-[26px] w-7 shrink-0 cursor-pointer rounded-md bg-btn text-[13px] text-btn-text hover:bg-btn-hover disabled:cursor-default disabled:opacity-40"
                  >
                    ↑
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        <aside className="hidden min-h-0 w-[320px] shrink-0 flex-col border-l border-line bg-rail lg:flex">
          {viewing && wide ? (
            <SourcePanel source={viewing} onBack={closeViewer} />
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

      {viewing && !wide ? <SourceSheet source={viewing} onClose={closeViewer} /> : null}
    </div>
  );
}
