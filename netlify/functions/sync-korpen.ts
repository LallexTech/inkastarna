// Scheduled functions run only on Netlify's published production deployment.
// The existing authenticated Next.js endpoint owns sync and snapshot fallback.
export default async function () {
  const url = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret)
    return new Response("Sync is not configured", { status: 503 });
  const result = await fetch(new URL("/api/sync", url), {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(45000),
  });
  return new Response(result.ok ? "Sync complete" : "Sync failed", {
    status: result.ok ? 200 : 502,
  });
}
export const config = { schedule: "0 6 * * *" };
