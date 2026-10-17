"use client";

import { memo } from "react";

import RichText from "@/components/chat/RichText";
import MessageBubble from "@/components/chat/MessageBubble";
import QuestionCard from "@/components/study/QuestionCard";
import { InventoryBlock, MistakeCard, MockCard, StageLine, StudyPlanView } from "@/components/coach/blocks";
import type { BuildState } from "@/lib/mock-client";
import type { CoachBlock, CoachMessage } from "@/lib/coach";
import type { CoachStatus } from "@/lib/coach-stream";
import type { TutorSource } from "@/lib/sse";
import type { GradedAttempt, MockRow, PartResponse } from "@/lib/study";
import type { CoachQuestion } from "../../../supabase/functions/_shared/coach-blocks.ts";

export interface CardState {
  graded: GradedAttempt;
  responses: PartResponse[];
}

export interface ThreadHandlers {
  onCite: (messageId: string, n: number) => void;
  onGraded: (question: CoachQuestion, graded: GradedAttempt, responses: PartResponse[]) => void;
  onOpenSource: (source: TutorSource) => void;
  onOpenFile: (sourceId: string, title: string) => void;
  onAddMaterials: () => void;
  onTogglePlan: (itemId: string, done: boolean) => void;
  onMockBuilt: (mockId: string, state: BuildState) => void;
}

export interface Shared extends ThreadHandlers {
  courseId: string;
  examId: string;
  today: string;
  cards: Record<string, CardState>;
  topicTitle: (id: string) => string | null;
  mocks: readonly MockRow[];
  latestPlanKey: string | null;
}

const DIFFICULTY_LABEL: Record<number, string> = { 1: "Warm-up", 2: "Standard", 3: "Exam-level" };

const STATUS_COPY: Record<CoachStatus, string> = {
  searching: "Looking through your course…",
  writing_question: "Writing a question and checking its answer…",
  working: "Updating your plan…",
};

function QuestionBlock({ question, shared }: { question: CoachQuestion; shared: Shared }) {
  const card = shared.cards[question.id];
  const topicIds = card?.graded.topic_ids ?? question.topic_ids ?? [];
  const showTopics = topicIds.length > 0 && (!question.hide_topic || card);
  const topics = topicIds.map(shared.topicTitle).filter(Boolean).join(" + ");
  return (
    <section aria-label="Practice question" className="flex flex-col gap-3 rounded-[12px] border border-line bg-rail/60 px-3.5 py-3.5 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="font-bold uppercase tracking-[0.1em] text-ink3">Practice question</span>
        {question.difficulty ? <span className="text-ink3">· {DIFFICULTY_LABEL[question.difficulty]}</span> : null}
        {showTopics && topics ? (
          <span className="text-ink2">· {question.hide_topic ? `This one was about ${topics}` : topics}</span>
        ) : question.hide_topic ? (
          <span className="text-ink3">· Mixed: work out which ideas it needs</span>
        ) : null}
      </div>
      <QuestionCard
        courseId={shared.courseId}
        question={question}
        graded={card?.graded ?? null}
        initialResponses={card?.responses ?? null}
        onGraded={(graded, responses) => shared.onGraded(question, graded, responses)}
        onCite={(n) => {
          const source = card?.graded.sources.find((s) => s.n === n);
          if (source) shared.onOpenSource(source);
        }}
        onReported={() => undefined}
        talkThrough={false}
        explanationCollapsed
      />
    </section>
  );
}

function BlockView({ block, blockKey, shared }: { block: CoachBlock; blockKey: string; shared: Shared }) {
  switch (block.type) {
    case "question":
      return <QuestionBlock question={block.question} shared={shared} />;
    case "inventory":
      return <InventoryBlock inventory={block.inventory} onOpenSource={shared.onOpenFile} onAddMaterials={shared.onAddMaterials} />;
    case "plan":
      return (
        <section aria-label="Study plan" className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-4 py-3.5 shadow-card">
          <span className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink3">Your study plan</span>
          <StudyPlanView
            plan={block.plan}
            today={shared.today}
            live={shared.latestPlanKey === blockKey}
            compact
            onToggle={shared.onTogglePlan}
          />
        </section>
      );
    case "stage":
      return <StageLine title={block.title} stage={block.stage} note={block.note} />;
    case "error_logged":
      return (
        <MistakeCard
          error={block.error}
          topicTitle={block.error.topic_id ? shared.topicTitle(block.error.topic_id) : null}
          heading="Added to your mistakes"
        />
      );
    case "mock": {
      const live = shared.mocks.find((m) => m.id === block.mock.id);
      return (
        <MockCard
          mock={live ?? { id: block.mock.id, title: block.mock.title, minutes: block.mock.minutes, status: "building", due_at: null, score: null }}
          courseId={shared.courseId}
          examId={shared.examId}
          questionCount={block.mock.question_count}
          onBuilt={shared.onMockBuilt}
        />
      );
    }
    case "replies":
      return null; // shown above the message box for the newest turn
  }
}

const CoachTurn = memo(function CoachTurn({
  message,
  shared,
  activeCitation,
}: {
  message: CoachMessage;
  shared: Shared;
  activeCitation: number | null;
}) {
  if (message.kind === "user") {
    return <MessageBubble message={{ role: "user", content: message.text }} messageIndex={0} />;
  }
  if (message.kind === "event") {
    return (
      <div className="flex items-center gap-3 text-[11.5px] text-ink3">
        <span className="h-px flex-1 bg-line-soft" aria-hidden />
        <span>{message.label}</span>
        <span className="h-px flex-1 bg-line-soft" aria-hidden />
      </div>
    );
  }
  const lastText = message.segments.reduce((last, s, i) => (s.type === "text" ? i : last), -1);
  return (
    <div className="flex min-w-0 flex-col gap-3.5" aria-busy={message.streaming ? true : undefined}>
      {message.segments.map((segment, i) =>
        segment.type === "text" ? (
          <div key={i} className="min-w-0 animate-fade-up text-[14px] leading-[1.75] text-ink wrap-break-word">
            <RichText
              text={segment.text}
              onCite={(n) => shared.onCite(message.localId, n)}
              activeCitation={activeCitation}
              caret={message.streaming && i === lastText && i === message.segments.length - 1}
            />
          </div>
        ) : (
          <div key={i} className="min-w-0 motion-safe:animate-fade-up">
            <BlockView block={segment.block} blockKey={`${message.localId}:${i}`} shared={shared} />
          </div>
        ),
      )}
    </div>
  );
});

// `shared` must be memoized by the caller: every turn is memoized on it, so
// only the streaming turn re-renders as text arrives.
export default function CoachThread({
  messages,
  busy,
  status,
  activeCitation,
  shared,
}: {
  messages: readonly CoachMessage[];
  busy: boolean;
  status: CoachStatus | null;
  activeCitation: { messageId: string; n: number } | null;
  shared: Shared;
}) {
  const last = messages[messages.length - 1];
  const waiting = busy && (!last || last.kind !== "assistant" || last.segments.length === 0 || status !== null);
  return (
    <div role="log" aria-label="Your exam coach" className="flex flex-col gap-[22px]">
      {messages.map((message) => (
        <CoachTurn
          key={message.localId}
          message={message}
          shared={shared}
          activeCitation={activeCitation?.messageId === message.localId ? activeCitation.n : null}
        />
      ))}
      {waiting ? (
        <div role="status" className="flex items-center gap-[9px] text-[12.5px] text-ink3">
          <span className="h-1.5 w-1.5 animate-dot-pulse rounded-full bg-accent" aria-hidden />
          {status ? STATUS_COPY[status] : "Thinking…"}
        </div>
      ) : null}
    </div>
  );
}
