import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseConnection,
  EMPTY_CHOICE,
  parseChoice,
  pickConnection,
  setConnectionAside,
} from "../src/lib/canvas-connection.ts";

// Server order: oldest first.
const schoolA = { id: "a", status: "active" };
const schoolB = { id: "b", status: "active" };
const broken = { id: "x", status: "invalid" };

test("with no choice yet, the newest active connection wins", () => {
  assert.equal(pickConnection([schoolA, schoolB], EMPTY_CHOICE)?.id, "b");
  assert.equal(pickConnection([schoolA, broken], EMPTY_CHOICE)?.id, "a");
  assert.equal(pickConnection([broken], EMPTY_CHOICE), null);
  assert.equal(pickConnection([], EMPTY_CHOICE), null);
});

test("the remembered choice wins while it's still active", () => {
  const choice = chooseConnection(EMPTY_CHOICE, "a");
  assert.equal(pickConnection([schoolA, schoolB], choice)?.id, "a");
  // Its token stopped working: fall back to the newest usable one.
  assert.equal(pickConnection([{ id: "a", status: "invalid" }, schoolB], choice)?.id, "b");
});

test("'Use a different Canvas' sticks across a reload", () => {
  // Only one saved Canvas, set aside: show the connect options, not it again.
  const aside = setConnectionAside(EMPTY_CHOICE, "a");
  assert.equal(pickConnection([schoolA], aside), null);
  // Two saved, the current one set aside: the other one.
  const asideB = setConnectionAside(chooseConnection(EMPTY_CHOICE, "b"), "b");
  assert.deepEqual(asideB, { chosen: null, setAside: ["b"] });
  assert.equal(pickConnection([schoolA, schoolB], asideB)?.id, "a");
});

test("connecting a set-aside Canvas again brings it back", () => {
  const aside = setConnectionAside(EMPTY_CHOICE, "a");
  const back = chooseConnection(aside, "a");
  assert.deepEqual(back, { chosen: "a", setAside: [] });
  assert.equal(pickConnection([schoolA, schoolB], back)?.id, "a");
});

test("setting aside twice doesn't duplicate", () => {
  const once = setConnectionAside(EMPTY_CHOICE, "a");
  assert.deepEqual(setConnectionAside(once, "a"), once);
});

test("stored choice parsing never throws and drops junk", () => {
  assert.deepEqual(parseChoice(null), EMPTY_CHOICE);
  assert.deepEqual(parseChoice("not json"), EMPTY_CHOICE);
  assert.deepEqual(parseChoice('{"chosen":5,"setAside":["a",3,null,"b"]}'), {
    chosen: null,
    setAside: ["a", "b"],
  });
  assert.deepEqual(parseChoice('{"chosen":"a"}'), { chosen: "a", setAside: [] });
});
