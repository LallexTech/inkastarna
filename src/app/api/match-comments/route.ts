import { auth, appOrigins, isTeamAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { League } from "@/lib/types";
import { z } from "zod";

const commentId = z.number().int().positive();
const bodyText = z.string().trim().min(1, "Skriv en kommentar.").max(2000);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), matchId: commentId, body: bodyText }),
  z.object({ type: z.literal("update"), commentId, body: bodyText }),
  z.object({ type: z.literal("delete"), commentId }),
]);

async function belongsToTeam(matchId: number) {
  const [snapshot, friendly] = await Promise.all([
    db.query("SELECT data FROM league_snapshot WHERE id=1"),
    db.query("SELECT id FROM friendly_match WHERE id=$1", [matchId]),
  ]);
  const league = snapshot.rows[0]?.data as League | undefined;
  const official = league?.matches.some(
    (match) =>
      match.id === matchId &&
      (match.homeId === league.teamId || match.awayId === league.teamId),
  );
  return Boolean(official || friendly.rowCount);
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json({ error: "Logga in för att läsa matchkommentarer." }, { status: 401 });

  const matchId = Number(new URL(request.url).searchParams.get("matchId"));
  if (!Number.isSafeInteger(matchId) || matchId <= 0)
    return Response.json({ error: "Ogiltigt matchnummer." }, { status: 400 });
  if (!(await belongsToTeam(matchId)))
    return Response.json({ error: "Matchen finns inte i lagets spelschema." }, { status: 404 });

  const [comments, player, admin] = await Promise.all([
    db.query(
      `SELECT c.id,c.author_user_id AS "authorUserId",
              COALESCE(r.display_name,u.name) AS "authorName",
              c.body,c.created_at AS "createdAt",c.updated_at AS "updatedAt"
       FROM match_comment c
       JOIN "user" u ON u.id=c.author_user_id
       LEFT JOIN roster r ON r.user_id=c.author_user_id
       WHERE c.match_id=$1
       ORDER BY c.created_at,c.id`,
      [matchId],
    ),
    db.query("SELECT id FROM roster WHERE user_id=$1", [session.user.id]),
    isTeamAdmin(session.user.id, session.user.email),
  ]);

  return Response.json(
    {
      comments: comments.rows.map(({ authorUserId, ...comment }) => ({
        ...comment,
        canEdit: admin || authorUserId === session.user.id,
      })),
      canComment: Boolean(player.rowCount || admin),
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

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Skriv en kommentar på högst 2 000 tecken." }, { status: 400 });

  const data = parsed.data;
  const [player, admin] = await Promise.all([
    db.query("SELECT id FROM roster WHERE user_id=$1", [session.user.id]),
    isTeamAdmin(session.user.id, session.user.email),
  ]);
  if (data.type === "create") {
    if (!player.rowCount && !admin)
      return Response.json({ error: "Bara lagets spelare och administratörer kan kommentera." }, { status: 403 });
    if (!(await belongsToTeam(data.matchId)))
      return Response.json({ error: "Matchen finns inte i lagets spelschema." }, { status: 404 });
    const saved = await db.query(
      "INSERT INTO match_comment(match_id,author_user_id,body) VALUES($1,$2,$3) RETURNING id",
      [data.matchId, session.user.id, data.body],
    );
    return Response.json({ ok: true, commentId: saved.rows[0].id });
  }

  const existing = await db.query(
    "SELECT author_user_id AS \"authorUserId\" FROM match_comment WHERE id=$1",
    [data.commentId],
  );
  if (!existing.rowCount)
    return Response.json({ error: "Kommentaren finns inte längre." }, { status: 404 });
  if (!admin && existing.rows[0].authorUserId !== session.user.id)
    return Response.json({ error: "Du kan bara ändra dina egna kommentarer." }, { status: 403 });

  if (data.type === "update")
    await db.query(
      "UPDATE match_comment SET body=$2,updated_at=now() WHERE id=$1",
      [data.commentId, data.body],
    );
  else await db.query("DELETE FROM match_comment WHERE id=$1", [data.commentId]);
  return Response.json({ ok: true });
}
