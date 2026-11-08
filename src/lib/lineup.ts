export type LineupCandidate = { id: string; position: string };

/** Build a partial, valid lineup without retry loops when the squad is short. */
export function randomLineup(
  players: LineupCandidate[],
  availablePlayerIds: ReadonlySet<string>,
  random: () => number = Math.random,
): (string | null)[] {
  const slots: (string | null)[] = Array(5).fill(null);
  const eligible = players.filter((player) => availablePlayerIds.has(player.id));
  const goalkeepers = shuffle(eligible.filter((player) => player.position === "Målvakt"), random);
  const outfield = shuffle(eligible.filter((player) => player.position !== "Målvakt"), random);

  if (goalkeepers.length) slots[4] = goalkeepers[0].id;
  const selected = outfield.slice(0, 4);
  const outfieldSlots = [0, 1, 2, 3];
  const randomizedSlots = shuffle(outfieldSlots, random);
  selected.forEach((player, index) => {
    slots[randomizedSlots[index]] = player.id;
  });

  return slots;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
