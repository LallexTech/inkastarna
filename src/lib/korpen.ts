import type { League, Match, Standing } from "./types";

const origin = "https://korpenstockholm.zoezi.se";
export const TEAM_ID = 27757;
export const DIVISION_ID = 9266;
type RawMatch = {
  id: number;
  startTime: string;
  finished: boolean;
  location: string;
  competitors: { name: string; team_id: number; id: number }[];
  result: unknown[];
};

// Zoezi sends local Stockholm wall time without a timezone. Resolve the offset
// for the actual match date (CET/CEST), never the server's local timezone.
export function stockholmTime(raw: string): string {
  const iso = raw.replace(" ", "T");
  if (/Z$|[+-]\d{2}:\d{2}$/.test(iso)) return new Date(iso).toISOString();
  const guess = new Date(iso + "Z");
  if (!Number.isFinite(guess.getTime())) throw new Error("Ogiltigt matchdatum");
  const tz = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    timeZoneName: "longOffset",
  })
    .formatToParts(guess)
    .find((x) => x.type === "timeZoneName")?.value;
  return new Date(iso + (tz?.replace("GMT", "") || "+00:00")).toISOString();
}

export function normalizeMatch(raw: RawMatch): Match {
  if (raw.competitors.length !== 2)
    throw new Error("Okänt matchformat från Korpen");
  const score = (index: number): number | null => {
    const teamId = raw.competitors[index].team_id;
    const r = raw.result.some(
      (x) => typeof x === "object" && x !== null && "team_id" in x,
    )
      ? raw.result.find(
          (x) =>
            typeof x === "object" &&
            x !== null &&
            (x as { team_id: number }).team_id === teamId,
        )
      : raw.result[index];
    if (r == null) return null;
    if (typeof r === "object" && (r as { invalid_id?: number }).invalid_id)
      return null;
    // Zoezi associates official results with team_id, not array order.
    const v = typeof r === "object" ? (r as { result?: unknown }).result : r;
    if (v === null || v === undefined || v === "") return null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };
  return {
    id: raw.id,
    startsAt: stockholmTime(raw.startTime),
    location: raw.location || "Spelplats ej angiven",
    finished: raw.finished,
    home: raw.competitors[0].name.trim(),
    away: raw.competitors[1].name.trim(),
    homeId: raw.competitors[0].team_id,
    awayId: raw.competitors[1].team_id,
    homeScore: score(0),
    awayScore: score(1),
  };
}

async function get(path: string) {
  const response = await fetch(origin + path, {
    cache: "no-store",
    signal: AbortSignal.timeout(18000),
    headers: {
      Accept: "application/json",
      "User-Agent": "Inkastarna team app (read-only public league sync)",
    },
  });
  if (!response.ok) throw new Error(`Korpen svarade ${response.status}`);
  return response.json();
}

export async function fetchLeague(): Promise<League> {
  const [matches, table] = await Promise.all([
    get(`/api/teamsport/division/matches/get?id=${DIVISION_ID}`),
    get(
      `/api/memberapi/teamsport/result/for_division?division_id=${DIVISION_ID}`,
    ),
  ]);
  if (
    !Array.isArray(matches) ||
    !Array.isArray(table.rows) ||
    !Array.isArray(table.columns)
  )
    throw new Error("Korpens dataformat har ändrats");
  const fields: Record<string, keyof Standing> = {
    "#": "position",
    Lag: "team",
    Matcher: "played",
    Vinster: "won",
    Oavgjorda: "drawn",
    Förluster: "lost",
    "Gjorda mål": "goalsFor",
    Insläppta: "goalsAgainst",
    "+/-": "difference",
    Poäng: "points",
  };
  const standings: Standing[] = table.rows.map((row: unknown[]) => {
    const mapped: Record<string, string | number> = {};
    table.columns.forEach((col: { name: string }, i: number) => {
      const key = fields[col.name];
      if (key)
        mapped[key] = key === "team" ? String(row[i]).trim() : Number(row[i]);
    });
    if (
      Object.keys(mapped).length !== 10 ||
      Object.entries(mapped).some(
        ([k, v]) => k !== "team" && !Number.isFinite(v),
      )
    )
      throw new Error("Okänt tabellformat");
    return mapped as Standing;
  });
  // Player leaderboards may be empty before the season or unavailable publicly.
  let scorers: League["scorers"] = [],
    scorersAvailable = false;
  try {
    const top = await get(
      `/api/memberapi/teamsport/toplist/for_division?division_id=${DIVISION_ID}&toplist_id=3`,
    );
    const list = top.toplists?.find(
      (x: { toplist: { id: number } }) => x.toplist.id === 3,
    );
    if (list && Array.isArray(list.rows) && list.rows.length === 0)
      scorersAvailable = true;
    // Never guess column semantics. Preserve availability separately until a
    // non-empty feed can be mapped against its actual metadata.
    scorers = [];
  } catch {
    /* The fixtures/table remain usable if no public scoring feed exists. */
  }
  return {
    name: "Herr Söndag Norr · Division 2",
    season: "2026 / 2027",
    divisionId: DIVISION_ID,
    teamId: TEAM_ID,
    fetchedAt: new Date().toISOString(),
    matches: matches
      .map(normalizeMatch)
      .sort((a: Match, b: Match) => a.startsAt.localeCompare(b.startsAt)),
    standings,
    scorers,
    scorersAvailable,
  };
}
