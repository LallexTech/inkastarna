import assert from "node:assert/strict";
import test from "node:test";
import { randomLineup } from "../src/lib/lineup";

const players = [
  { id: "gk1", position: "Målvakt" },
  { id: "gk2", position: "Målvakt" },
  { id: "back", position: "Back" },
  { id: "mid", position: "Mittfältare" },
  { id: "forward", position: "Anfallare" },
  { id: "allround", position: "Allround" },
];

test("random lineup uses only confirmed players and keeps goalkeepers in goal", () => {
  for (let iteration = 0; iteration < 30; iteration++) {
    const slots = randomLineup(players, new Set(["gk1", "back", "mid", "forward", "allround"]));
    const selected = slots.filter((id): id is string => Boolean(id));
    assert.equal(selected.length, 5);
    assert.equal(new Set(selected).size, selected.length);
    assert.equal(slots[4], "gk1");
    assert.ok(slots.slice(0, 4).every((id) => id !== "gk1" && id !== "gk2"));
  }
});

test("random lineup leaves the goalkeeper slot empty when none is available", () => {
  const slots = randomLineup(players, new Set(["back", "mid", "forward"]));
  assert.equal(slots.filter(Boolean).length, 3);
  assert.equal(slots[4], null);
});

test("random lineup selects one of several goalkeepers without using another outfield", () => {
  const slots = randomLineup(players, new Set(players.map((player) => player.id)));
  assert.ok(["gk1", "gk2"].includes(slots[4] ?? ""));
  assert.equal(slots.filter(Boolean).length, 5);
  assert.equal(slots.slice(0, 4).filter((id) => id === "gk1" || id === "gk2").length, 0);
});

test("random lineup returns a partial lineup without retrying when fewer players are available", () => {
  const slots = randomLineup(players, new Set(["gk2", "allround"]), () => 0);
  assert.equal(slots.filter(Boolean).length, 2);
  assert.equal(slots[4], "gk2");
  assert.equal(slots.filter(Boolean).includes("not-available"), false);
});

test("random lineup returns empty slots when no one is available", () => {
  assert.deepEqual(randomLineup(players, new Set()), Array(5).fill(null));
});
