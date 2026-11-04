import { syncLeague } from '../src/lib/league-store';
import { db } from '../src/lib/db';
const league = await syncLeague();
console.log(`Synk klar: ${league.matches.length} matcher, ${league.standings.length} lag. ${league.fetchedAt}`);
await db.end();
