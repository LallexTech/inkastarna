import { timingSafeEqual } from "node:crypto";
import { syncLeague } from "@/lib/league-store";
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (
    !expected ||
    !actual ||
    Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const league = await syncLeague();
    return Response.json({
      ok: true,
      updatedAt: league.fetchedAt,
      matches: league.matches.length,
    });
  } catch {
    return Response.json(
      { error: "Synkroniseringen misslyckades. Tidigare data är bevarad." },
      { status: 502 },
    );
  }
}
