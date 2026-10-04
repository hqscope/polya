"use client";

import { useEffect } from "react";

import { trackActivity } from "@/lib/track";

// Keeps an open Polya tab counted as live, and stops counting it once the tab
// is hidden — a backgrounded tab is not somebody studying. Matches the 5-minute
// cadence the other clients use; the dashboard treats an install as live for
// 10 minutes, i.e. two missed beats.
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Mounted in the /app layout rather than the root layout on purpose: marketing
 * pageviews would swamp the product numbers, and "read the landing page" is not
 * "used Polya".
 */
export default function ActivityReporter() {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    function beat() {
      if (document.visibilityState !== "visible") return;
      trackActivity();
    }

    function start() {
      if (timer) return;
      timer = setInterval(beat, HEARTBEAT_MS);
    }

    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        beat();
        start();
      } else {
        stop();
      }
    }

    beat();
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
