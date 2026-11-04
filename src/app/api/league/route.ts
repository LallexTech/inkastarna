import { readLeague } from "@/lib/league-store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const data = await readLeague();
    return Response.json(data, {
      status: data.league ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Matchinformationen kan inte hämtas just nu." },
      { status: 503 },
    );
  }
}
