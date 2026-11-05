import { ARCHIVE_SEASONS, fetchLeague } from "@/lib/korpen";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const divisionId = Number(new URL(request.url).searchParams.get("divisionId"));
  const season = ARCHIVE_SEASONS.find((item) => item.divisionId === divisionId);
  if (!season)
    return Response.json({ error: "Den säsongen finns inte i arkivet." }, { status: 404 });

  try {
    return Response.json(await fetchLeague(season.divisionId, season.season), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Säsongens statistik kan inte hämtas från Korpen just nu." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
