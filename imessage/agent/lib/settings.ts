// Check-in settings a student can change by text: on/off, quiet hours, timezone.
// Pure (tests import it); tools/check_in_settings.ts does the read and write.
import { isValidTimeZone } from "./dates.ts";
import type { LinkRow, LinkSettingsPatch } from "./link.ts";

export interface SettingsInput {
  enabled?: boolean;
  quiet_start?: number;
  quiet_end?: number;
  timezone?: string;
}

export type SettingsPlan =
  | { readonly kind: "read" }
  | { readonly kind: "update"; readonly patch: LinkSettingsPatch }
  | { readonly kind: "invalid"; readonly reason: string };

type CurrentSettings = Pick<LinkRow, "check_ins_enabled" | "quiet_start" | "quiet_end" | "timezone">;

function isHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

/** Validates a change against the current settings and returns the columns to write. */
export function planSettingsUpdate(current: CurrentSettings, input: SettingsInput): SettingsPlan {
  const patch: LinkSettingsPatch = {};
  if (input.enabled !== undefined) patch.check_ins_enabled = input.enabled;

  if (input.timezone !== undefined) {
    const timezone = input.timezone.trim();
    if (!isValidTimeZone(timezone)) {
      return { kind: "invalid", reason: `"${input.timezone}" isn't a timezone name. Use an IANA name such as America/New_York.` };
    }
    patch.timezone = timezone;
  }

  if (input.quiet_start !== undefined || input.quiet_end !== undefined) {
    const start = input.quiet_start ?? current.quiet_start;
    const end = input.quiet_end ?? current.quiet_end;
    if (!isHour(start) || !isHour(end)) {
      return { kind: "invalid", reason: "Quiet hours are whole local hours from 0 to 23." };
    }
    if (start === end) {
      return {
        kind: "invalid",
        reason: "Quiet hours need different start and end hours. To stop check-ins entirely, set enabled to false.",
      };
    }
    if (input.quiet_start !== undefined) patch.quiet_start = start;
    if (input.quiet_end !== undefined) patch.quiet_end = end;
  }

  return Object.keys(patch).length === 0 ? { kind: "read" } : { kind: "update", patch };
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/** The settings as the model should relay them. */
export function describeSettings(settings: CurrentSettings) {
  return {
    check_ins: settings.check_ins_enabled ? "on" : "off",
    quiet_hours: `${hourLabel(settings.quiet_start)} to ${hourLabel(settings.quiet_end)}`,
    quiet_start: settings.quiet_start,
    quiet_end: settings.quiet_end,
    timezone: settings.timezone,
  };
}
