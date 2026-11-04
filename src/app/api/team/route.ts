import { auth, isAdmin, appOrigins } from "@/lib/auth";
import { db } from "@/lib/db";
import { readLeague } from "@/lib/league-store";
import { z } from "zod";

const attendance = z.object({
  type: z.literal("attendance"),
  matchId: z.number().int().positive(),
  status: z.enum(["yes", "maybe", "no"]),
});
const profile = z.object({
  type: z.literal("profile"),
  number: z.number().int().min(1).max(99).nullable(),
  position: z.enum(["Målvakt", "Back", "Mittfältare", "Anfallare", "Allround"]),
});
const lineup = z.object({
  type: z.literal("lineup"),
  matchId: z.number().int().positive(),
  slots: z.array(z.string().nullable()).length(5),
});
const stats = z.object({
  type: z.literal("stats"),
  matchId: z.number().int().positive(),
  playerId: z.string(),
  goals: z.number().int().min(0).max(100),
  assists: z.number().int().min(0).max(100),
  played: z.boolean(),
});
const schema = z.discriminatedUnion("type", [
  attendance,
  profile,
  lineup,
  stats,
]);

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json(
      { error: "Logga in för att se laget." },
      { status: 401 },
    );
  const [players, responses, lineups] = await Promise.all([
    db.query(
      "SELECT r.id, r.name, p.number, COALESCE(p.position, $1) AS position, COALESCE(s.goals,0)::int AS goals, COALESCE(s.assists,0)::int AS assists, COALESCE(s.appearances,0)::int AS appearances FROM roster r LEFT JOIN player_profile p ON p.user_id=r.user_id LEFT JOIN (SELECT player_id, SUM(goals) AS goals, SUM(assists) AS assists, COUNT(*) FILTER (WHERE played) AS appearances FROM player_stats GROUP BY player_id) s ON s.player_id=r.id ORDER BY r.name",
      ["Allround"],
    ),
    db.query(
      'SELECT a.match_id AS "matchId", a.user_id AS "userId", u.name, a.status FROM attendance a JOIN "user" u ON u.id=a.user_id',
    ),
    db.query('SELECT match_id AS "matchId", slots FROM lineup'),
  ]);
  const player = await db.query("SELECT id FROM roster WHERE user_id=$1", [
    session.user.id,
  ]);
  return Response.json(
    {
      players: players.rows,
      attendance: responses.rows,
      lineups: lineups.rows,
      admin: isAdmin(session.user.email),
      ...(isAdmin(session.user.email)
        ? { inviteCode: process.env.TEAM_JOIN_CODE }
        : {}),
      userId: session.user.id,
      playerId: player.rows[0]?.id ?? null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json({ error: "Logga in först." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin))
    return Response.json({ error: "Ogiltigt ursprung." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Kontrollera uppgifterna." },
      { status: 400 },
    );
  const data = parsed.data;
  if (data.type === "profile") {
    await db.query(
      "INSERT INTO player_profile(user_id,number,position) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET number=$2, position=$3",
      [session.user.id, data.number, data.position],
    );
  } else {
    const { league } = await readLeague();
    const match = league?.matches.find(
      (m) =>
        m.id === data.matchId &&
        (m.homeId === league.teamId || m.awayId === league.teamId),
    );
    if (!match)
      return Response.json(
        { error: "Matchen finns inte i lagets spelschema." },
        { status: 404 },
      );
    if (data.type === "stats") {
      if (!isAdmin(session.user.email))
        return Response.json(
          { error: "Bara lagledaren kan registrera statistik." },
          { status: 403 },
        );
      if (!match.finished)
        return Response.json(
          { error: "Matchen måste vara färdigspelad hos Korpen." },
          { status: 409 },
        );
      const player = await db.query("SELECT id FROM roster WHERE id=$1", [
        data.playerId,
      ]);
      if (!player.rowCount)
        return Response.json({ error: "Okänd spelare." }, { status: 404 });
      if (!data.played && (data.goals || data.assists))
        return Response.json(
          { error: "Mål och assist kräver att spelaren deltagit." },
          { status: 400 },
        );
      await db.query(
        "INSERT INTO player_stats(match_id,player_id,goals,assists,played) VALUES($1,$2,$3,$4,$5) ON CONFLICT(match_id,player_id) DO UPDATE SET goals=$3,assists=$4,played=$5",
        [data.matchId, data.playerId, data.goals, data.assists, data.played],
      );
    } else if (
      match.finished ||
      new Date(match.startsAt).getTime() <= Date.now()
    ) {
      return Response.json(
        { error: "Matchen har redan börjat." },
        { status: 409 },
      );
    } else if (data.type === "attendance") {
      await db.query(
        "INSERT INTO attendance(match_id,user_id,status) VALUES($1,$2,$3) ON CONFLICT(match_id,user_id) DO UPDATE SET status=$3, updated_at=now()",
        [data.matchId, session.user.id, data.status],
      );
    } else {
      if (!isAdmin(session.user.email))
        return Response.json(
          { error: "Bara lagledaren kan spara laguppställningen." },
          { status: 403 },
        );
      const ids = data.slots.filter((x): x is string => x !== null);
      if (new Set(ids).size !== ids.length)
        return Response.json(
          { error: "En spelare kan bara ha en plats." },
          { status: 400 },
        );
      if (ids.length) {
        const users = await db.query(
          "SELECT id FROM roster WHERE id = ANY($1::text[])",
          [ids],
        );
        if (users.rowCount !== ids.length)
          return Response.json(
            { error: "Spelaren finns inte i truppen." },
            { status: 400 },
          );
      }
      await db.query(
        "INSERT INTO lineup(match_id,slots,updated_by) VALUES($1,$2,$3) ON CONFLICT(match_id) DO UPDATE SET slots=$2,updated_by=$3,updated_at=now()",
        [data.matchId, JSON.stringify(data.slots), session.user.id],
      );
    }
  }
  return Response.json({ ok: true });
}
