import { randomUUID } from "node:crypto";
import { auth, isAdmin, isTeamAdmin, isTeamLeader, appOrigins } from "@/lib/auth";
import { db } from "@/lib/db";
import { readLeague } from "@/lib/league-store";
import type { League } from "@/lib/types";
import { z } from "zod";

const positions = z.enum(["Målvakt", "Back", "Mittfältare", "Anfallare", "Allround"]);
const attendance = z.object({ type: z.literal("attendance"), matchId: z.number().int().positive(), status: z.enum(["yes", "maybe", "no"]) });
const profile = z.object({ type: z.literal("profile"), number: z.number().int().min(1).max(99).nullable(), position: positions });
const lineup = z.object({ type: z.literal("lineup"), matchId: z.number().int().positive(), slots: z.array(z.string().nullable()).length(5), formation: z.enum(["1-2-1", "2-2"]).default("1-2-1") });
const teamLeader = z.object({ type: z.literal("teamLeader"), playerId: z.string().min(1), enabled: z.boolean() });
const teamAdmin = z.object({ type: z.literal("teamAdmin"), playerId: z.string().min(1), enabled: z.boolean() });
const rosterPlayer = z.object({ type: z.literal("rosterPlayer"), playerId: z.string().optional(), name: z.string().trim().min(1).max(80), number: z.number().int().min(1).max(99).nullable(), position: positions });
const stats = z.object({ type: z.literal("stats"), matchId: z.number().int().positive(), playerId: z.string(), goals: z.number().int().min(0).max(100), assists: z.number().int().min(0).max(100), played: z.boolean() });
const presence = z.object({ type: z.literal("presence"), matchId: z.number().int().positive(), players: z.array(z.object({ playerId: z.string().min(1), status: z.enum(["played", "spectator", "absent"]) })).max(100) });
const friendlyMatch = z.object({ type: z.literal("friendlyMatch"), matchId: z.number().int().positive().optional(), opponent: z.string().trim().min(1).max(100), startsAt: z.string().datetime(), homeScore:z.number().int().min(0).max(100).nullable().optional(), awayScore:z.number().int().min(0).max(100).nullable().optional() });
const deleteFriendlyMatch = z.object({type:z.literal("deleteFriendlyMatch"),matchId:z.number().int().positive()});
const schema = z.discriminatedUnion("type", [attendance, profile, lineup, teamLeader, teamAdmin, rosterPlayer, stats, presence, friendlyMatch, deleteFriendlyMatch]);

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Logga in för att se laget." }, { status: 401 });
  const snapshot=await db.query("SELECT data FROM league_snapshot WHERE id=1");
  const league=snapshot.rows[0]?.data as League|undefined;
  const [players, responses, lineups, teamLeads, teamAdmins, friendlies, presences, ballots, ratings, motms, currentPlayer, playerMatchStats] = await Promise.all([
    db.query(`SELECT r.id, r.display_name AS name, r.user_id IS NOT NULL AS "hasAccount", r.user_id, u.email, rp.number, COALESCE(rp.position,p.position,'Allround') AS position, (rp.photo IS NOT NULL) AS "hasPhoto", COALESCE(s.goals,0)::int AS goals, COALESCE(s.assists,0)::int AS assists, COALESCE(s.appearances,0)::int AS appearances, (ta.user_id IS NOT NULL) AS admin FROM roster r LEFT JOIN "user" u ON u.id=r.user_id LEFT JOIN roster_profile rp ON rp.player_id=r.id LEFT JOIN player_profile p ON p.user_id=r.user_id LEFT JOIN team_admin ta ON ta.user_id=r.user_id LEFT JOIN (SELECT player_id,SUM(goals) goals,SUM(assists) assists,COUNT(*) FILTER(WHERE played) appearances FROM player_stats GROUP BY player_id) s ON s.player_id=r.id ORDER BY r.display_name`),
    db.query('SELECT a.match_id AS "matchId", a.user_id AS "userId", u.name, a.status FROM attendance a JOIN "user" u ON u.id=a.user_id'),
    db.query('SELECT match_id AS "matchId", slots, formation FROM lineup'),
    db.query("SELECT r.id FROM team_leader tl JOIN roster r ON r.user_id=tl.user_id"),
    db.query("SELECT r.id FROM team_admin ta JOIN roster r ON r.user_id=ta.user_id"),
    db.query("SELECT id,opponent,starts_at AS \"startsAt\",home_score AS \"homeScore\",away_score AS \"awayScore\" FROM friendly_match ORDER BY starts_at DESC"),
    db.query('SELECT match_id AS "matchId",player_id AS "playerId",status FROM match_presence'),
    db.query('SELECT match_id AS "matchId",closed_at IS NULL AS open,closed_at IS NOT NULL AS closed FROM match_ballot'),
    db.query(`SELECT mr.match_id AS "matchId",mr.player_id AS "playerId",AVG(mr.stars)::float AS average,COUNT(*)::int AS count FROM match_rating mr JOIN match_presence target ON target.match_id=mr.match_id AND target.player_id=mr.player_id AND target.status='played' JOIN match_vote v ON v.match_id=mr.match_id AND v.voter_user_id=mr.voter_user_id JOIN match_ballot b ON b.match_id=mr.match_id AND b.closed_at IS NOT NULL JOIN roster voter ON voter.user_id=v.voter_user_id JOIN match_presence vp ON vp.match_id=v.match_id AND vp.player_id=voter.id AND vp.status IN ('played','spectator') GROUP BY mr.match_id,mr.player_id`),
    db.query(`SELECT v.match_id AS "matchId",v.motm_player_id AS "playerId",COUNT(*)::int AS count,BOOL_AND(b.closed_at IS NOT NULL) AS closed,MAX(b.motm_winner_id) AS "winnerId" FROM match_vote v JOIN match_ballot b ON b.match_id=v.match_id JOIN roster voter ON voter.user_id=v.voter_user_id JOIN match_presence vp ON vp.match_id=v.match_id AND vp.player_id=voter.id AND vp.status IN ('played','spectator') JOIN match_presence target ON target.match_id=v.match_id AND target.player_id=v.motm_player_id AND target.status='played' WHERE v.motm_player_id IS NOT NULL GROUP BY v.match_id,v.motm_player_id`),
    db.query("SELECT id FROM roster WHERE user_id=$1", [session.user.id]),
    db.query('SELECT match_id AS "matchId",player_id AS "playerId",goals,assists,played FROM player_stats'),
  ]);
  const admin = await isTeamAdmin(session.user.id, session.user.email);
  const leader = await isTeamLeader(session.user.id, session.user.email);
  const officialIds = new Set((league?.matches ?? []).filter((m) => m.finished && (m.homeId === league?.teamId || m.awayId === league?.teamId)).map((m) => m.id));
  const matchRatings = ratings.rows.map((r) => {
    const closedMotms=motms.rows.filter((m) => m.matchId === r.matchId && m.closed);
    return { matchId:r.matchId,playerId:r.playerId,average:r.average,winner: Boolean(closedMotms.find((m)=>m.winnerId===r.playerId)) };
  });
  const seasonRatings = new Map<string,{ total:number; count:number; matches:Set<number>; motm:number }>();
  const statisticMatchIds=new Set([...officialIds,...friendlies.rows.map((m)=>Number(m.id))]);
  for (const r of ratings.rows) if (statisticMatchIds.has(Number(r.matchId))) {
    const v=seasonRatings.get(r.playerId) ?? { total:0,count:0,matches:new Set<number>(),motm:0 };
    v.total += Number(r.average)*Number(r.count); v.count += Number(r.count); v.matches.add(Number(r.matchId)); seasonRatings.set(r.playerId,v);
  }
  const officialMotmByMatch=new Map<number,typeof motms.rows>();
  for (const m of motms.rows) if (statisticMatchIds.has(Number(m.matchId)) && m.closed) officialMotmByMatch.set(Number(m.matchId),[...(officialMotmByMatch.get(Number(m.matchId))??[]),m]);
  for (const [matchId,rows] of officialMotmByMatch) {
    const winner=rows.find((x)=>x.winnerId);
    if (winner) { const v=seasonRatings.get(winner.playerId) ?? {total:0,count:0,matches:new Set<number>(),motm:0}; v.motm++; seasonRatings.set(winner.playerId,v); }
  }
  const friendlyMatches = friendlies.rows.map((m) => ({ id:m.id, startsAt:new Date(m.startsAt).toISOString(), location:"Träningsmatch", finished:true, home:"Inkastarna", away:m.opponent, homeId:27757, awayId:0, homeScore:m.homeScore===null?null:Number(m.homeScore), awayScore:m.awayScore===null?null:Number(m.awayScore), friendly:true }));
  return Response.json({
    players: players.rows.map(({ user_id, email, hasPhoto, ...p }) => ({ ...p, rootAdmin:isAdmin(email ?? ""), admin:Boolean(p.admin || isAdmin(email ?? "")), photoUrl:hasPhoto ? `/api/player-photo?id=${encodeURIComponent(p.id)}` : null })),
    attendance:responses.rows, lineups:lineups.rows, teamLeads:teamLeads.rows.map((r)=>r.id), teamAdmins:teamAdmins.rows.map((r)=>r.id), admin, leader,
    ...(admin ? { inviteCode:process.env.TEAM_JOIN_CODE } : {}), userId:session.user.id, playerId:currentPlayer.rows[0]?.id ?? null,
    friendlyMatches, matchPresence:presences.rows, ballots:ballots.rows, ratings:matchRatings.map((r)=>({...r,average:Math.max(3,Number(r.average))})),
    seasonRatings:[...seasonRatings.entries()].map(([playerId,v])=>({playerId,average:v.count ? Math.max(3,v.total/v.count) : null,matches:v.matches.size,motm:v.motm})), playerMatchStats:playerMatchStats.rows,
  }, { headers:{ "Cache-Control":"private, no-store" } });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error:"Logga in först." }, {status:401});
  const origin=request.headers.get("origin");
  if (!origin || !appOrigins().includes(origin)) return Response.json({error:"Ogiltigt ursprung."},{status:403});
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return Response.json({error:"Kontrollera uppgifterna."},{status:400});
  const data=parsed.data;
  const admin=await isTeamAdmin(session.user.id,session.user.email);
  const leader=await isTeamLeader(session.user.id,session.user.email);
  if (data.type === "profile") {
    const player=await db.query("SELECT id FROM roster WHERE user_id=$1",[session.user.id]);
    if (!player.rowCount) return Response.json({error:"Kontot är inte kopplat till en spelarprofil."},{status:404});
    await db.query("INSERT INTO roster_profile(player_id,number,position) VALUES($1,$2,$3) ON CONFLICT(player_id) DO UPDATE SET number=$2,position=$3,updated_at=now()",[player.rows[0].id,data.number,data.position]);
  } else if (data.type === "rosterPlayer") {
    if (!admin) return Response.json({error:"Bara administratörer kan ändra truppen."},{status:403});
    const duplicate=await db.query("SELECT id FROM roster WHERE lower(COALESCE(display_name,name))=lower($1) AND ($2::text IS NULL OR id<>$2)",[data.name,data.playerId ?? null]);
    if (duplicate.rowCount) return Response.json({error:"En spelare med det namnet finns redan."},{status:409});
    if (data.playerId) {
      const updated=await db.query("UPDATE roster SET display_name=$2 WHERE id=$1 RETURNING id",[data.playerId,data.name]);
      if (!updated.rowCount) return Response.json({error:"Spelaren finns inte."},{status:404});
      await db.query("INSERT INTO roster_profile(player_id,number,position) VALUES($1,$2,$3) ON CONFLICT(player_id) DO UPDATE SET number=$2,position=$3,updated_at=now()",[data.playerId,data.number,data.position]);
    } else {
      const id=randomUUID();
      await db.query("INSERT INTO roster(id,name,display_name) VALUES($1,$2,$2)",[id,data.name]);
      await db.query("INSERT INTO roster_profile(player_id,number,position) VALUES($1,$2,$3)",[id,data.number,data.position]);
    }
  } else if (data.type === "teamAdmin" || data.type === "teamLeader") {
    if (!admin) return Response.json({error:"Bara administratörer kan ändra behörigheter."},{status:403});
    const player=await db.query('SELECT r.user_id,u.email FROM roster r LEFT JOIN "user" u ON u.id=r.user_id WHERE r.id=$1',[data.playerId]);
    if (!player.rows[0]?.user_id) return Response.json({error:"Spelaren behöver ha ett konto först."},{status:409});
    if (data.type === "teamAdmin") {
      if (!data.enabled && isAdmin(player.rows[0].email ?? "")) return Response.json({error:"Huvudadministratören kan inte tas bort."},{status:409});
      if (data.enabled) await db.query("INSERT INTO team_admin(user_id,assigned_by) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",[player.rows[0].user_id,session.user.id]);
      else await db.query("DELETE FROM team_admin WHERE user_id=$1",[player.rows[0].user_id]);
    } else if (data.enabled) await db.query("INSERT INTO team_leader(user_id,assigned_by) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",[player.rows[0].user_id,session.user.id]);
    else {
      const count=await db.query("SELECT count(*)::int AS count FROM team_leader");
      if (Number(count.rows[0].count)<=1 && !isAdmin(session.user.email)) return Response.json({error:"Minst en lagledare måste finnas kvar."},{status:409});
      await db.query("DELETE FROM team_leader WHERE user_id=$1",[player.rows[0].user_id]);
    }
  } else if (data.type === "friendlyMatch") {
    if (!leader) return Response.json({error:"Bara lagledare kan hantera träningsmatcher."},{status:403});
    if (new Date(data.startsAt).getTime()>Date.now()) return Response.json({error:"Registrera träningsmatchen efter att den är färdigspelad."},{status:400});
    if (((data.homeScore??null)===null) !== ((data.awayScore??null)===null)) return Response.json({error:"Fyll i målen för båda lagen, eller lämna båda tomma."},{status:400});
    if (data.matchId) {
      const updated=await db.query("UPDATE friendly_match SET opponent=$2,starts_at=$3,home_score=$4,away_score=$5 WHERE id=$1",[data.matchId,data.opponent,new Date(data.startsAt),data.homeScore??null,data.awayScore??null]);
      if (!updated.rowCount) return Response.json({error:"Träningsmatchen finns inte."},{status:404});
    } else await db.query("INSERT INTO friendly_match(opponent,starts_at,created_by,home_score,away_score) VALUES($1,$2,$3,$4,$5)",[data.opponent,new Date(data.startsAt),session.user.id,data.homeScore??null,data.awayScore??null]);
  } else if (data.type === "deleteFriendlyMatch") {
    if (!leader) return Response.json({error:"Bara lagledare kan ta bort träningsmatcher."},{status:403});
    const client=await db.connect();
    try { await client.query("BEGIN");
      const exists=await client.query("SELECT id FROM friendly_match WHERE id=$1 FOR UPDATE",[data.matchId]);
      if (!exists.rowCount) { await client.query("ROLLBACK"); return Response.json({error:"Träningsmatchen finns inte."},{status:404}); }
      await client.query("DELETE FROM match_vote WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM match_ballot WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM match_presence WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM player_stats WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM lineup WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM attendance WHERE match_id=$1",[data.matchId]);
      await client.query("DELETE FROM friendly_match WHERE id=$1",[data.matchId]);
      await client.query("COMMIT");
    } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } else if (data.type === "presence") {
    if (!leader) return Response.json({error:"Bara lagledare kan ändra närvaro."},{status:403});
    const {league}=await readLeague();
    const official=league?.matches.find((m)=>m.id===data.matchId && m.finished && (m.homeId===league.teamId || m.awayId===league.teamId));
    const friendly=await db.query("SELECT id FROM friendly_match WHERE id=$1",[data.matchId]);
    if (!official && !friendly.rowCount) return Response.json({error:"Matchen finns inte eller är inte färdigspelad."},{status:404});
    const ids=data.players.map((p)=>p.playerId);
    if (new Set(ids).size !== ids.length) return Response.json({error:"En spelare kan bara ha en närvaroroll."},{status:400});
    if (ids.length) {
      const found=await db.query("SELECT id FROM roster WHERE id=ANY($1::text[])",[ids]);
      if (found.rowCount!==ids.length) return Response.json({error:"Okänd spelare."},{status:400});
    }
    const client=await db.connect();
    try { await client.query("BEGIN"); await client.query("DELETE FROM match_presence WHERE match_id=$1",[data.matchId]);
      for (const p of data.players) await client.query("INSERT INTO match_presence(match_id,player_id,status,updated_by) VALUES($1,$2,$3,$4)",[data.matchId,p.playerId,p.status,session.user.id]);
      await client.query("COMMIT");
    } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } else if (data.type === "stats") {
    if (!leader) return Response.json({error:"Bara lagledare kan registrera statistik."},{status:403});
    const {league}=await readLeague();
    const match=league?.matches.find((m)=>m.id===data.matchId && (m.homeId===league.teamId || m.awayId===league.teamId));
    if (!match) return Response.json({error:"Matchen finns inte i lagets spelschema."},{status:404});
    if (!match.finished) return Response.json({error:"Matchen måste vara färdigspelad hos Korpen."},{status:409});
    const player=await db.query("SELECT id FROM roster WHERE id=$1",[data.playerId]);
    if (!player.rowCount) return Response.json({error:"Okänd spelare."},{status:404});
    if (!data.played && (data.goals || data.assists)) return Response.json({error:"Mål och assist kräver att spelaren deltagit."},{status:400});
    await db.query("INSERT INTO player_stats(match_id,player_id,goals,assists,played) VALUES($1,$2,$3,$4,$5) ON CONFLICT(match_id,player_id) DO UPDATE SET goals=$3,assists=$4,played=$5",[data.matchId,data.playerId,data.goals,data.assists,data.played]);
    if (data.played) await db.query("INSERT INTO match_presence(match_id,player_id,status,updated_by) VALUES($1,$2,'played',$3) ON CONFLICT(match_id,player_id) DO UPDATE SET status='played',updated_by=$3,updated_at=now()",[data.matchId,data.playerId,session.user.id]);
    else await db.query("DELETE FROM match_presence WHERE match_id=$1 AND player_id=$2 AND status='played'",[data.matchId,data.playerId]);
  } else if (data.type === "attendance") {
    const {league}=await readLeague(); const match=league?.matches.find((m)=>m.id===data.matchId && (m.homeId===league.teamId || m.awayId===league.teamId));
    if (!match) return Response.json({error:"Matchen finns inte i lagets spelschema."},{status:404});
    if (match.finished || new Date(match.startsAt).getTime()<=Date.now()) return Response.json({error:"Matchen har redan börjat."},{status:409});
    await db.query("INSERT INTO attendance(match_id,user_id,status) VALUES($1,$2,$3) ON CONFLICT(match_id,user_id) DO UPDATE SET status=$3,updated_at=now()",[data.matchId,session.user.id,data.status]);
  } else {
    if (!leader) return Response.json({error:"Bara lagledare kan spara laguppställningen."},{status:403});
    const ids=data.slots.filter((x):x is string=>x!==null);
    if (new Set(ids).size!==ids.length) return Response.json({error:"En spelare kan bara ha en plats."},{status:400});
    if (ids.length) { const users=await db.query("SELECT id FROM roster WHERE id=ANY($1::text[])",[ids]); if (users.rowCount!==ids.length) return Response.json({error:"Spelaren finns inte i truppen."},{status:400}); }
    await db.query("INSERT INTO lineup(match_id,slots,formation,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(match_id) DO UPDATE SET slots=$2,formation=$3,updated_by=$4,updated_at=now()",[data.matchId,JSON.stringify(data.slots),data.formation,session.user.id]);
  }
  return Response.json({ok:true});
}
