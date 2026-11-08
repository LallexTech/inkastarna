import { createHmac } from "node:crypto";
import { auth, appOrigins } from "@/lib/auth";
import { db } from "@/lib/db";

const roomPattern = /^[A-HJ-NP-Z2-9]{6}$/;

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Logga in för att spela." }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin)) return Response.json({ error: "Ogiltigt ursprung." }, { status: 403 });

  const body = await request.json().catch(() => null) as { roomId?: unknown } | null;
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

  const payload = Buffer.from(JSON.stringify({
    roomId: body.roomId,
    playerId: result.rows[0].id,
    name: result.rows[0].name,
    team: "inkastarna",
    exp: Math.floor(Date.now() / 1000) + 45,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return Response.json({ ticket: `${payload}.${signature}` }, { headers: { "Cache-Control": "no-store" } });
}
