import { defineSchedule } from "eve/schedules";

import { runCheckIns } from "../lib/run-check-ins.ts";

export default defineSchedule({
  // Every 30 minutes, evaluated in UTC by Vercel Cron. This cadence needs Vercel Pro: Hobby
  // allows a cron at most once a day. The run is idempotent (each check-in is claimed in
  // polya_imessage_reminders, or polya_imessage_check_ins before that migration, before it's
  // sent), quiet hours and "due today" are decided in each
  // student's own time zone, so the cadence only controls how promptly check-ins go out.
  // POST /polya/check-ins/run (channels/check-ins.ts) runs the same loop as a manual or backup trigger.
  cron: "*/30 * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      runCheckIns(to, new Date()).then(
        (counts) => console.log("[polya check-ins] scheduled run", counts),
        (error: unknown) => console.error("[polya check-ins] scheduled run failed", error),
      ),
    );
  },
});
