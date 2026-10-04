"use client";

import { useEffect, useRef } from "react";

import SourcePanel from "@/components/viewer/SourcePanel";
import type { TutorSource } from "@/lib/sse";

const FOCUSABLE =
  'a[href], button:not([disabled]), iframe, textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Below the `lg` breakpoint there's no sources rail, so a clicked citation
// opens here: a bottom sheet over the chat. Escape, the backdrop, or Close
// dismiss it, and focus goes back to the citation that opened it.
export default function SourceSheet({
  source,
  onClose,
}: {
  source: TutorSource;
  /** Must be stable (useCallback) — it's an effect dependency. */
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Move focus in on open; hand it back to whatever opened the sheet on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      // Keep Tab inside the sheet while it's open.
      if (event.key !== "Tab" || !sheetRef.current) return;
      const items = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === sheetRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-ink/25" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={source.title}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 mx-auto flex h-[85dvh] max-w-[720px] animate-fade-up flex-col overflow-hidden rounded-t-[14px] border border-b-0 border-line bg-rail shadow-[0_-18px_40px_-24px_rgba(25,31,29,0.45)] outline-none"
      >
        <SourcePanel source={source} onBack={onClose} backLabel="Close" />
      </div>
    </div>
  );
}
