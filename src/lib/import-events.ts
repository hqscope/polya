// Lets the imports indicator stop polling when nothing is importing and wake
// up the moment something starts. Anything that starts an import calls
// `announceImportStarted()`.

export const IMPORT_STARTED_EVENT = "polya:import-started";

export function announceImportStarted(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IMPORT_STARTED_EVENT));
}
