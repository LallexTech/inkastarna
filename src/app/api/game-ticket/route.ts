import { createHmac } from "node:crypto";
import { auth, appOrigins } from "@/lib/auth";
import { db } from "@/lib/db";

const roomPattern = /^[A-HJ-NP-Z2-9]{6}$/;

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Logga in för att spela." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin)) return Response.json({ error: "Ogiltigt ursprung." }, { status: 403 });

  const body = await request.json().catch(() => null) as { roomId?: unknown; characterId?: unknown } | null;
  if (!body || typeof body.roomId !== "string" || !roomPattern.test(body.roomId)) {
    return Response.json({ error: "Rumskoden är ogiltig." }, { status: 400 });
  }
  const secret = process.env.GAME_TICKET_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Spelet är inte konfigurerat ännu." }, { status: 503 });

  const result = await db.query(
    `SELECT r.id,COALESCE(r.display_name,u.name) AS name
     FROM roster r JOIN "user" u ON u.id=r.user_id WHERE r.user_id=$1`,
    [session.user.id],
  );
  if (!result.rowCount) return Response.json({ error: "Koppla ditt konto till en spelarprofil för att spela." }, { status: 403 });

  const characterId = typeof body.characterId === "string" && body.characterId.length <= 100 ? body.characterId : result.rows[0].id;
  const character = await db.query(
    `SELECT r.id,COALESCE(r.display_name,r.name) AS name,(rp.photo IS NOT NULL) AS "hasPhoto",
       COALESCE(gp.speed,3)::int AS speed,COALESCE(gp.acceleration,3)::int AS acceleration,
       COALESCE(gp.size,3)::int AS size,COALESCE(gp.tackling,3)::int AS tackling,gp.ability_id AS "abilityId"
     FROM roster r LEFT JOIN roster_profile rp ON rp.player_id=r.id LEFT JOIN roster_game_profile gp ON gp.player_id=r.id WHERE r.id=$1`,
    [characterId],
  );
  if (!character.rowCount) return Response.json({ error: "Den valda truppspelaren finns inte." }, { status: 404 });

  const payload = Buffer.from(JSON.stringify({
    roomId: body.roomId,
    playerId: result.rows[0].id,
    characterId: character.rows[0].id,
    name: character.rows[0].name,
    avatarUrl: character.rows[0].hasPhoto ? `/api/player-photo?id=${encodeURIComponent(character.rows[0].id)}` : null,
    gameProfile: { speed: character.rows[0].speed, acceleration: character.rows[0].acceleration, size: character.rows[0].size, tackling: character.rows[0].tackling, abilityId: character.rows[0].abilityId },
    team: "inkastarna",
    exp: Math.floor(Date.now() / 1000) + 45,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return Response.json({ ticket: `${payload}.${signature}` }, { headers: { "Cache-Control": "no-store" } });
}
