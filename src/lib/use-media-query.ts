"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Tailwind's `lg` breakpoint (64rem), where the chat's sources rail appears. */
export const WIDE_LAYOUT_QUERY = "(min-width: 64rem)";

/**
 * Live `matchMedia` result. `serverValue` is what the server render and the
 * first client paint assume, before the browser has been asked.
 */
export function useMediaQuery(query: string, serverValue = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
