"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), iframe, textarea, input, select, [tabindex]:not([tabindex="-1"])';

// A bottom sheet over the page for narrow screens. Escape, the backdrop, or the
// content's own close button dismiss it; focus moves in on open and goes back
// to whatever opened it on close.
export default function BottomSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  /** Must be stable (useCallback): it's an effect dependency. */
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

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
        aria-label={label}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 mx-auto flex h-[85dvh] max-w-[720px] animate-fade-up flex-col overflow-hidden rounded-t-[14px] border border-b-0 border-line bg-rail shadow-[0_-18px_40px_-24px_rgba(25,31,29,0.45)] outline-none"
      >
        {children}
      </div>
    </div>
  );
}
