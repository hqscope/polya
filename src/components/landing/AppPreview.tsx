// Static replica of the study screen, framed in browser chrome, for the
// landing hero. Pure presentation — every string is illustrative.
export default function AppPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_40px_80px_-48px_rgba(25,31,29,0.45)]">
      <div className="flex h-9 items-center gap-1.5 border-b border-line-soft bg-rail px-3.5">
        <span className="h-2 w-2 rounded-full bg-line" />
        <span className="h-2 w-2 rounded-full bg-line" />
        <span className="h-2 w-2 rounded-full bg-line" />
        <span className="mx-auto rounded-[5px] bg-line-soft px-3 py-[3px] font-mono text-[10.5px] text-ink3">
          askpolya.com/courses/cs-3510
        </span>
        <span className="w-[38px]" />
      </div>

      <div className="flex text-left">
        <div className="hidden w-[148px] shrink-0 flex-col gap-0.5 border-r border-line-soft bg-bg px-2 py-3 sm:flex">
          <span className="px-2 py-0.5 text-[12px] font-bold tracking-[-0.02em]">
            Polya
          </span>
          <span className="mt-2.5 rounded-[5px] border border-line-soft bg-surface px-2 py-1 text-[11px] font-semibold">
            My courses
          </span>
          <span className="px-2 py-1 text-[11px] font-medium text-ink2">
            Connect Canvas
          </span>
          <span className="mt-2.5 px-2 text-[9px] font-[650] uppercase tracking-[0.09em] text-ink3">
            Courses
          </span>
          <span className="px-2 py-[3px] text-[10.5px] font-semibold text-accent-ink">
            CS 3510
          </span>
          <span className="px-2 py-[3px] text-[10.5px] text-ink2">
            MATH 2551
          </span>
          <span className="px-2 py-[3px] text-[10.5px] text-ink2">
            ECON 2101
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-[9px]">
            <span className="text-[12px] font-semibold">
              Design &amp; Analysis of Algorithms
            </span>
            <span className="rounded bg-accent-soft px-[7px] py-0.5 text-[9px] font-[650] uppercase tracking-[0.07em] text-accent-ink">
              Guided
            </span>
          </div>
          <div className="flex flex-col gap-[13px] px-[18px] py-4">
            <div className="flex justify-end">
              <span className="max-w-[70%] rounded-[9px] bg-line-soft px-[11px] py-[7px] text-[11.5px] leading-normal">
                Can you just solve Problem 4 for me?
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-accent-ink">
                Hint · rung 1 of 3
              </span>
              <p className="m-0 text-[12px] leading-[1.65] text-ink">
                I won&apos;t hand you the answer — but let&apos;s get you
                there. Your recursion tree does the same work at every level
                <span className="mx-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded bg-accent-soft px-[3px] align-[2px] text-[9.5px] font-bold text-accent-ink">
                  1
                </span>
                . Add up one level — what do you get?
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-[9px] border border-line px-[9px] py-[7px]">
              <span className="rounded-[5px] border border-line px-[9px] py-[3px] text-[10px] font-semibold text-ink2">
                I&apos;m stuck — next step
              </span>
              <span className="text-[10.5px] text-ink3">
                Ask about your course…
              </span>
              <span className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-btn text-[10px] text-btn-text">
                ↑
              </span>
            </div>
          </div>
        </div>

        <div className="hidden w-[212px] shrink-0 flex-col gap-2 border-l border-line-soft bg-rail p-3 lg:flex">
          <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-ink3">
            Sources · 2
          </span>
          <div className="flex flex-col gap-[3px] rounded-[7px] border border-accent bg-surface px-[9px] py-2">
            <span className="flex items-center gap-[5px]">
              <span className="inline-flex h-[13px] min-w-[13px] items-center justify-center rounded bg-accent text-[9px] font-bold text-on-accent">
                1
              </span>
              <span className="text-[10.5px] font-semibold">
                Lecture 9 — Divide &amp; Conquer
              </span>
            </span>
            <span className="font-mono text-[9px] text-ink3">
              12:40–13:55 · transcript
            </span>
            <span className="text-[9.5px] leading-normal text-ink2">
              &quot;…every level of the tree does exactly n work…&quot;
            </span>
          </div>
          <div className="flex flex-col gap-[3px] rounded-[7px] border border-line-soft bg-surface px-[9px] py-2">
            <span className="flex items-center gap-[5px]">
              <span className="inline-flex h-[13px] min-w-[13px] items-center justify-center rounded bg-accent-soft text-[9px] font-bold text-accent-ink">
                2
              </span>
              <span className="text-[10.5px] font-semibold">Problem Set 3</span>
            </span>
            <span className="font-mono text-[9px] text-ink3">p. 2 · PDF</span>
          </div>
        </div>
      </div>
    </div>
  );
}
