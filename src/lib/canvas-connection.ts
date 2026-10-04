// Which saved Canvas connection the connect page uses (POLISH P-27).
//
// A student can have one saved connection per school (the platform keeps one
// row per user + Canvas address, shared with Scope and Lectra). The page used
// to take the oldest active one on every load, so "Use a different Canvas"
// snapped back after a reload. Now this browser remembers the student's choice:
// the connection they last connected, minus any they've set aside with "Use a
// different Canvas". Nothing is deleted: the set-aside connection keeps
// working in Scope and Lectra.
//
// Pure except for the two storage helpers, which never throw.

export interface ConnectionChoice {
  /** The connection this browser last connected or picked. */
  chosen: string | null;
  /** Connections set aside with "Use a different Canvas". */
  setAside: string[];
}

export const EMPTY_CHOICE: ConnectionChoice = { chosen: null, setAside: [] };

const STORAGE_KEY = "polya.canvasConnectionChoice";

interface ConnectionLike {
  id: string;
  status: string;
}

/**
 * `connections` in the order the server lists them (oldest first). Returns the
 * remembered connection if it's still active and not set aside, otherwise the
 * newest active one that isn't set aside, otherwise null (show the connect
 * options).
 */
export function pickConnection<T extends ConnectionLike>(
  connections: T[],
  choice: ConnectionChoice,
): T | null {
  const usable = connections.filter(
    (c) => c.status === "active" && !choice.setAside.includes(c.id),
  );
  return usable.find((c) => c.id === choice.chosen) ?? usable[usable.length - 1] ?? null;
}

/** After connecting (or reconnecting) a Canvas: use it from now on. */
export function chooseConnection(choice: ConnectionChoice, id: string): ConnectionChoice {
  return { chosen: id, setAside: choice.setAside.filter((other) => other !== id) };
}

/** "Use a different Canvas": stop auto-selecting this one. */
export function setConnectionAside(choice: ConnectionChoice, id: string): ConnectionChoice {
  return {
    chosen: choice.chosen === id ? null : choice.chosen,
    setAside: choice.setAside.includes(id) ? choice.setAside : [...choice.setAside, id],
  };
}

export function parseChoice(raw: string | null): ConnectionChoice {
  if (!raw) return EMPTY_CHOICE;
  try {
    const value = JSON.parse(raw) as Partial<ConnectionChoice>;
    return {
      chosen: typeof value.chosen === "string" ? value.chosen : null,
      setAside: Array.isArray(value.setAside)
        ? value.setAside.filter((id): id is string => typeof id === "string").slice(-20)
        : [],
    };
  } catch {
    return EMPTY_CHOICE;
  }
}

export function readConnectionChoice(): ConnectionChoice {
  try {
    return parseChoice(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_CHOICE;
  }
}

export function writeConnectionChoice(choice: ConnectionChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private mode or blocked storage: the page falls back to the newest connection.
  }
}
