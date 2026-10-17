"use client";

import BottomSheet from "@/components/ui/BottomSheet";
import SourcePanel from "@/components/viewer/SourcePanel";
import type { TutorSource } from "@/lib/sse";

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
  return (
    <BottomSheet label={source.title} onClose={onClose}>
      <SourcePanel source={source} onBack={onClose} backLabel="Close" />
    </BottomSheet>
  );
}
