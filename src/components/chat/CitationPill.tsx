"use client";

interface Props {
  n: number;
  active?: boolean;
  onClick?: (n: number) => void;
}

// Inline [n] citation marker rendered as a small clickable chip.
export default function CitationPill({ n, active, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(n)}
      className={`mx-0.5 inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded px-1 align-[2px] text-[10.5px] font-bold transition-colors ${
        active
          ? "bg-accent text-on-accent"
          : "bg-accent-soft text-accent-ink hover:bg-accent hover:text-on-accent"
      }`}
      aria-label={`Source ${n}`}
    >
      {n}
    </button>
  );
}
