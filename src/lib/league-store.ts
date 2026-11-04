import { db } from './db';
import { fetchLeague } from './korpen';
import type { League } from './types';

export async function syncLeague() {
  const league = await fetchLeague();
  await db.query('INSERT INTO league_snapshot (id, data, fetched_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()', [JSON.stringify(league)]);
  return league;
}

export async function readLeague(): Promise<{ league: League | null; stale: boolean }> {
  const { rows } = await db.query('SELECT data, fetched_at FROM league_snapshot WHERE id = 1');
  const snapshot = rows[0];
  if (snapshot && Date.now() - new Date(snapshot.fetched_at).getTime() < 15 * 60000) return { league: snapshot.data, stale: false };
  try { return { league: await syncLeague(), stale: false }; }
  catch (error) {
    console.error('League sync failed:', error instanceof Error ? error.message : 'unknown');
    return { league: snapshot?.data ?? null, stale: true };
  }
}
