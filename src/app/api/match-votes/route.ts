import { auth, appOrigins, isTeamLeader } from "@/lib/auth";
import { db } from "@/lib/db";
import type { League } from "@/lib/types";
import { z } from "zod";

const bodySchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("open"),matchId:z.number().int().positive()}),
  z.object({type:z.literal("close"),matchId:z.number().int().positive()}),
  z.object({type:z.literal("delete"),matchId:z.number().int().positive()}),
  z.object({type:z.literal("vote"),matchId:z.number().int().positive(),motmPlayerId:z.string().nullable(),ratings:z.array(z.object({playerId:z.string(),stars:z.number().int().min(1).max(5)})).max(100)}),
]);

async function pickMotmWinner(matchId:number) {
  const result=await db.query(`SELECT v.motm_player_id AS "playerId",COUNT(DISTINCT v.voter_user_id)::int AS votes,COALESCE(SUM(given.stars),0)::int AS "starsGiven"
    FROM match_vote v
    JOIN match_presence target ON target.match_id=v.match_id AND target.player_id=v.motm_player_id AND target.status='played'
    JOIN roster voter ON voter.user_id=v.voter_user_id
    JOIN match_presence vp ON vp.match_id=v.match_id AND vp.player_id=voter.id AND vp.status IN ('played','spectator')
    LEFT JOIN match_rating given ON given.match_id=v.match_id AND given.voter_user_id=v.voter_user_id
    WHERE v.match_id=$1 AND v.motm_player_id IS NOT NULL
    GROUP BY v.motm_player_id`,[matchId]);
  if (!result.rowCount) return null;
  const maxVotes=Math.max(...result.rows.map((row)=>Number(row.votes)));
  const voteLeaders=result.rows.filter((row)=>Number(row.votes)===maxVotes);
  const maxStars=Math.max(...voteLeaders.map((row)=>Number(row.starsGiven)));
  const finalLeaders=voteLeaders.filter((row)=>Number(row.starsGiven)===maxStars);
  return String(finalLeaders[Math.floor(Math.random()*finalLeaders.length)].playerId);
}

async function getMotmWinner(matchId:number,closed:boolean) {
  if (!closed) return null;
  const existing=await db.query("SELECT motm_winner_id AS winner FROM match_ballot WHERE match_id=$1",[matchId]);
  if (existing.rows[0]?.winner) return String(existing.rows[0].winner);
  const winner=await pickMotmWinner(matchId);
  if (!winner) return null;
  const saved=await db.query("UPDATE match_ballot SET motm_winner_id=$2 WHERE match_id=$1 AND closed_at IS NOT NULL AND motm_winner_id IS NULL RETURNING motm_winner_id AS winner",[matchId,winner]);
  if (saved.rowCount) return String(saved.rows[0].winner);
  const current=await db.query("SELECT motm_winner_id AS winner FROM match_ballot WHERE match_id=$1",[matchId]);
  return current.rows[0]?.winner ? String(current.rows[0].winner) : winner;
}

async function validMatch(matchId:number) {
  const [snapshot,friendly]=await Promise.all([db.query("SELECT data FROM league_snapshot WHERE id=1"),db.query("SELECT id FROM friendly_match WHERE id=$1",[matchId])]);
  const league=snapshot.rows[0]?.data as League|undefined;
  const official=league?.matches.find((m)=>m.id===matchId && m.finished && (m.homeId===league.teamId || m.awayId===league.teamId));
  return {ok:Boolean(official || friendly.rowCount),friendly:Boolean(friendly.rowCount)};
}

export async function GET(request:Request) {
  const session=await auth.api.getSession({headers:request.headers});
  if (!session) return Response.json({error:"Logga in för att se omröstningen."},{status:401});
  const matchId=Number(new URL(request.url).searchParams.get("matchId"));
  if (!Number.isSafeInteger(matchId) || matchId<=0) return Response.json({error:"Ogiltigt matchnummer."},{status:400});
  if (!(await validMatch(matchId)).ok) return Response.json({error:"Matchen finns inte eller är inte färdigspelad."},{status:404});
  const [ballot,presence,candidates,ratings,motms,myRoster,myVote,myRatings]=await Promise.all([
    db.query('SELECT closed_at AS "closedAt" FROM match_ballot WHERE match_id=$1',[matchId]),
    db.query('SELECT mp.player_id AS "playerId",r.display_name AS name,mp.status,r.user_id AS "userId" FROM match_presence mp JOIN roster r ON r.id=mp.player_id WHERE mp.match_id=$1 ORDER BY name',[matchId]),
    db.query('SELECT r.id AS "playerId",r.display_name AS name, (r.user_id=$2) AS self FROM match_presence mp JOIN roster r ON r.id=mp.player_id WHERE mp.match_id=$1 AND mp.status=\'played\' ORDER BY name',[matchId,session.user.id]),
    db.query(`SELECT mr.player_id AS "playerId",AVG(mr.stars)::float AS average,COUNT(*)::int AS count FROM match_rating mr JOIN match_presence target ON target.match_id=mr.match_id AND target.player_id=mr.player_id AND target.status='played' JOIN roster voter ON voter.user_id=mr.voter_user_id JOIN match_presence vp ON vp.match_id=mr.match_id AND vp.player_id=voter.id AND vp.status IN ('played','spectator') WHERE mr.match_id=$1 GROUP BY mr.player_id`,[matchId]),
    db.query(`SELECT v.motm_player_id AS "playerId",COUNT(*)::int AS count,BOOL_AND(b.closed_at IS NOT NULL) AS closed FROM match_vote v JOIN match_ballot b ON b.match_id=v.match_id JOIN roster voter ON voter.user_id=v.voter_user_id JOIN match_presence vp ON vp.match_id=v.match_id AND vp.player_id=voter.id AND vp.status IN ('played','spectator') JOIN match_presence target ON target.match_id=v.match_id AND target.player_id=v.motm_player_id AND target.status='played' WHERE v.match_id=$1 AND v.motm_player_id IS NOT NULL GROUP BY v.motm_player_id`,[matchId]),
    db.query("SELECT id FROM roster WHERE user_id=$1",[session.user.id]),
    db.query("SELECT motm_player_id AS \"motmPlayerId\" FROM match_vote WHERE match_id=$1 AND voter_user_id=$2",[matchId,session.user.id]),
    db.query('SELECT player_id AS "playerId",stars FROM match_rating WHERE match_id=$1 AND voter_user_id=$2',[matchId,session.user.id]),
  ]);
  const isOpen=Boolean(ballot.rows[0] && !ballot.rows[0].closedAt);
  const eligible=Boolean(myRoster.rows[0] && presence.rows.some((p)=>p.userId===session.user.id && ["played","spectator"].includes(p.status)));
  const closed=Boolean(ballot.rows[0]?.closedAt);
  const winnerId=await getMotmWinner(matchId,closed);
  return Response.json({open:isOpen,closed,eligible,players:candidates.rows,presence:presence.rows.map(({userId,...p})=>p),ratings:ratings.rows.map(({count,...r})=>({...r,average:Math.max(3,Number(r.average))})),winnerId,ownBallot:myVote.rows[0]??null,ownRatings:myRatings.rows},{headers:{"Cache-Control":"private, no-store"}});
}

export async function POST(request:Request) {
  const session=await auth.api.getSession({headers:request.headers});
  if (!session) return Response.json({error:"Logga in först."},{status:401});
  const origin=request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin)) return Response.json({error:"Ogiltigt ursprung."},{status:403});
  const parsed=bodySchema.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return Response.json({error:"Kontrollera uppgifterna."},{status:400});
  const data=parsed.data;
  if (!(await validMatch(data.matchId)).ok) return Response.json({error:"Matchen finns inte eller är inte färdigspelad."},{status:404});
  if (data.type==="open" || data.type==="close") {
    if (!(await isTeamLeader(session.user.id,session.user.email))) return Response.json({error:"Bara lagledare kan öppna eller stänga omröstningen."},{status:403});
    if (data.type==="open") {
      const [played,existing]=await Promise.all([db.query("SELECT 1 FROM match_presence WHERE match_id=$1 AND status='played' LIMIT 1",[data.matchId]),db.query("SELECT closed_at FROM match_ballot WHERE match_id=$1",[data.matchId])]);
      if (!played.rowCount) return Response.json({error:"Markera minst en spelare som deltagit innan omröstningen öppnas."},{status:409});
      if (existing.rows[0]?.closed_at) {
        await db.query("UPDATE match_ballot SET opened_by=$2,opened_at=now(),closed_by=NULL,closed_at=NULL,motm_winner_id=NULL WHERE match_id=$1",[data.matchId,session.user.id]);
      } else {
        await db.query("INSERT INTO match_ballot(match_id,opened_by) VALUES($1,$2) ON CONFLICT(match_id) DO NOTHING",[data.matchId,session.user.id]);
      }
    } else {
      const winner=await pickMotmWinner(data.matchId);
      const closed=await db.query("UPDATE match_ballot SET closed_by=$2,closed_at=now(),motm_winner_id=$3 WHERE match_id=$1 AND closed_at IS NULL RETURNING match_id",[data.matchId,session.user.id,winner]);
      if (!closed.rowCount) return Response.json({error:"Omröstningen är inte öppen."},{status:409});
    }
    return Response.json({ok:true});
  }
  if (data.type==="delete") {
    if (!(await isTeamLeader(session.user.id,session.user.email))) return Response.json({error:"Bara lagledare kan ta bort omröstningar."},{status:403});
    const client=await db.connect();
    try {
      await client.query("BEGIN");
      const ballot=await client.query("SELECT closed_at FROM match_ballot WHERE match_id=$1 FOR UPDATE",[data.matchId]);
      if (!ballot.rows[0]?.closed_at) { await client.query("ROLLBACK"); return Response.json({error:"Bara en avslutad omröstning kan tas bort."},{status:409}); }
      await client.query("DELETE FROM match_vote WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM match_ballot WHERE match_id=$1",[data.matchId]);
      await client.query("COMMIT");
    } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    return Response.json({ok:true});
  }
  const ballot=await db.query("SELECT closed_at FROM match_ballot WHERE match_id=$1",[data.matchId]);
  if (!ballot.rowCount || ballot.rows[0].closed_at) return Response.json({error:"Omröstningen är inte öppen."},{status:409});
  const voter=await db.query("SELECT r.id FROM roster r JOIN match_presence mp ON mp.player_id=r.id WHERE r.user_id=$1 AND mp.match_id=$2 AND mp.status IN ('played','spectator')",[session.user.id,data.matchId]);
  if (!voter.rowCount) return Response.json({error:"Bara spelare och åskådare som markerats närvarande kan rösta."},{status:403});
  const rosterPlayer=await db.query("SELECT id FROM roster WHERE user_id=$1",[session.user.id]);
  const ownId=rosterPlayer.rows[0]?.id;
  const rated=data.ratings.map((r)=>r.playerId);
  if (new Set(rated).size!==rated.length) return Response.json({error:"Varje spelare kan bara betygsättas en gång."},{status:400});
  if (ownId && (data.motmPlayerId===ownId || rated.includes(ownId))) return Response.json({error:"Du kan inte rösta på dig själv."},{status:400});
  const targets=[...rated,...(data.motmPlayerId?[data.motmPlayerId]:[])];
  if (targets.length) {
    const valid=await db.query("SELECT player_id FROM match_presence WHERE match_id=$1 AND status='played' AND player_id=ANY($2::text[])",[data.matchId,targets]);
    if (new Set(valid.rows.map((r)=>r.player_id)).size!==new Set(targets).size) return Response.json({error:"Du kan bara betygsätta spelare som deltagit."},{status:400});
  }
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const locked=await client.query("SELECT closed_at FROM match_ballot WHERE match_id=$1 FOR UPDATE",[data.matchId]);
    if (!locked.rowCount || locked.rows[0].closed_at) {
      await client.query("ROLLBACK");
      return Response.json({error:"Omröstningen är inte öppen."},{status:409});
    }
    await client.query("INSERT INTO match_vote(match_id,voter_user_id,motm_player_id) VALUES($1,$2,$3) ON CONFLICT(match_id,voter_user_id) DO UPDATE SET motm_player_id=$3,submitted_at=now()",[data.matchId,session.user.id,data.motmPlayerId]);
    await client.query("DELETE FROM match_rating WHERE match_id=$1 AND voter_user_id=$2",[data.matchId,session.user.id]);
    for (const rating of data.ratings) await client.query("INSERT INTO match_rating(match_id,voter_user_id,player_id,stars) VALUES($1,$2,$3,$4)",[data.matchId,session.user.id,rating.playerId,rating.stars]);
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  return Response.json({ok:true});
}
