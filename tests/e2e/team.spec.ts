import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import fixture from "../fixtures/league.json" with { type: "json" };

const password = randomBytes(24).toString("hex");
const sql = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const testPlayers = [
  { id: "qa-admin", name: "QA Admin", email: "qa-admin@inkastarna.invalid" },
  { id: "qa-player", name: "QA Player", email: "qa-player@inkastarna.invalid" },
  { id: "qa-spectator", name: "QA Spectator", email: "qa-spectator@inkastarna.invalid" },
];
const friendlyIds:number[]=[];

test.beforeAll(async () => {
  if (process.env.CI) {
    // Only the disposable CI database uses fixtures. Production always syncs
    // official Korpen data. Keep CI independent of upstream uptime and dates.
    const shift =
      Date.now() +
      7 * 86400000 -
      new Date(fixture.matches[0].startsAt).getTime();
    const data = {
      ...fixture,
      fetchedAt: new Date().toISOString(),
      matches: fixture.matches.map((m) => ({
        ...m,
        startsAt: new Date(
          new Date(m.startsAt).getTime() + shift,
        ).toISOString(),
      })),
    };
    await sql.query(
      "INSERT INTO league_snapshot(id,data,fetched_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET data=$1,fetched_at=now()",
      [JSON.stringify(data)],
    );
  }
  for (const p of testPlayers)
    await sql.query(
      "INSERT INTO roster(id,name,display_name) VALUES($1,$2,$2) ON CONFLICT DO NOTHING",
      [p.id, p.name],
    );
});
test.afterAll(async () => {
  if (friendlyIds.length) {
    await sql.query("DELETE FROM match_vote WHERE match_id=ANY($1::int[])",[friendlyIds]);
    await sql.query("DELETE FROM match_presence WHERE match_id=ANY($1::int[])",[friendlyIds]);
    await sql.query("DELETE FROM match_ballot WHERE match_id=ANY($1::int[])",[friendlyIds]);
    await sql.query("DELETE FROM friendly_match WHERE id=ANY($1::int[])",[friendlyIds]);
  }
  // Only delete exact accounts and rows owned by this named QA fixture.
  await sql.query(
    'DELETE FROM lineup WHERE updated_by IN (SELECT id FROM "user" WHERE email=ANY($1::text[]))',
    [testPlayers.map((p) => p.email)],
  );
  await sql.query('DELETE FROM "user" WHERE email=ANY($1::text[])', [
    testPlayers.map((p) => p.email),
  ]);
  await sql.query("DELETE FROM roster WHERE id=ANY($1::text[])", [
    testPlayers.map((p) => p.id),
  ]);
  await sql.query("DELETE FROM roster WHERE lower(name)=lower($1)",["QA Added Player"]);
  await sql.end();
});

test("PWA and mobile navigation use the real schedule", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dags för nästa inkast." }),
  ).toBeVisible();
  await expect(
    page.getByText("Rigor Mortis FC", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Öppna menyn" }).click();
  await page
    .getByRole("button", { name: "Spelade matcher", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Historien skriver vi tillsammans." }),
  ).toBeVisible();
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons)
    expect((await request.get(icon.src)).status()).toBe(200);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.context().setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Vi är strax tillbaka på planen." }),
  ).toBeVisible();
  await page.context().setOffline(false);
});

test("team-code access, session, RSVP persistence and admin lineup", async ({
  page,
  request,
  playwright,
}) => {
  const anon = await request.get("/api/team");
  expect(anon.status()).toBe(401);
  const denied = await request.post("/api/auth/sign-up/email", {
    data: { name: "QA Player", email: testPlayers[1].email, password },
    headers: { "x-team-code": "wrong", origin: "http://localhost:3100" },
  });
  expect(denied.status()).toBe(403);
  const hijack = await request.post("/api/auth/sign-up/email", {
    data: { name: "QA Admin", email: testPlayers[0].email, password },
    headers: {
      "x-team-code": process.env.TEAM_JOIN_CODE!,
      origin: "http://localhost:3100",
    },
  });
  expect(hijack.status()).toBe(403);
  for (const p of testPlayers) {
    const context = await playwright.request.newContext({
      baseURL: "http://localhost:3100",
    });
    const signup = await context.post("/api/auth/sign-up/email", {
      data: { name: p.name, email: p.email, password },
      headers: {
        "x-team-code":
          p.id === "qa-admin"
            ? process.env.ADMIN_JOIN_CODE!
            : process.env.TEAM_JOIN_CODE!,
        origin: "http://localhost:3100",
      },
    });
    expect(signup.status(), await signup.text()).toBe(200);
    await context.dispose();
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await page.getByLabel("E-post", { exact: true }).fill(testPlayers[1].email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Logga in", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "QP QA Player", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Svara på kallelsen", exact: true })
    .click();
  await page.getByRole("button", { name: "Kommer", exact: true }).click();
  await expect(
    page.getByText("QA Player · Kommer", { exact: true }),
  ).toBeVisible();
  await page.reload();
  const memberData = await (await page.request.get("/api/team")).json();
  expect(
    memberData.attendance.some(
      (a: { name: string; status: string }) =>
        a.name === "QA Player" && a.status === "yes",
    ),
  ).toBe(true);
  const league = (await (await request.get("/api/league")).json()).league;
  const match = league.matches.find(
    (m: { homeId: number; awayId: number; finished: boolean }) =>
      (m.homeId === 27757 || m.awayId === 27757) && !m.finished,
  );
  const lineupData = {
    type: "lineup",
    matchId: match.id,
    slots: ["qa-admin", "qa-player", null, null, null],
    formation: "2-2",
  };
  const forbidden = await page.request.post("/api/team", {
    data: lineupData,
    headers: { origin: "http://localhost:3100" },
  });
  expect(forbidden.status()).toBe(403);
  const csrf = await page.request.post("/api/team", {
    data: { type: "attendance", matchId: match.id, status: "yes" },
    headers: { origin: "https://untrusted.invalid" },
  });
  expect(csrf.status()).toBe(403);
  const admin = await playwright.request.newContext({
    baseURL: "http://localhost:3100",
  });
  await admin.post("/api/auth/sign-in/email", {
    data: { email: testPlayers[0].email, password },
    headers: { origin: "http://localhost:3100" },
  });
  const duplicate = await admin.post("/api/team", {
    data: { ...lineupData, slots: ["qa-admin", "qa-admin", null, null, null] },
    headers: { origin: "http://localhost:3100" },
  });
  expect(duplicate.status()).toBe(400);
  const saved = await admin.post("/api/team", {
    data: lineupData,
    headers: { origin: "http://localhost:3100" },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const adminData = await (await admin.get("/api/team")).json();
  expect(adminData.admin).toBe(true);
  expect(
    adminData.lineups.find((x: { matchId: number }) => x.matchId === match.id)
      .slots,
  ).toEqual(lineupData.slots);
  expect(
    adminData.lineups.find((x: { matchId: number }) => x.matchId === match.id)
      .formation,
  ).toBe("2-2");
  const promoted = await admin.post("/api/team", {
    data: { type: "teamLeader", playerId: "qa-player", enabled: true },
    headers: { origin: "http://localhost:3100" },
  });
  expect(promoted.status(), await promoted.text()).toBe(200);
  const promotedData = await (await page.request.get("/api/team")).json();
  expect(promotedData.admin).toBe(false);
  expect(promotedData.leader).toBe(true);
  const leaderLineup = await page.request.post("/api/team", {
    data: { ...lineupData, formation: "1-2-1" },
    headers: { origin: "http://localhost:3100" },
  });
  expect(leaderLineup.status()).toBe(200);
  const demoted = await admin.post("/api/team", {
    data: { type: "teamLeader", playerId: "qa-player", enabled: false },
    headers: { origin: "http://localhost:3100" },
  });
  expect(demoted.status()).toBe(200);
  const demotedData = await (await page.request.get("/api/team")).json();
  expect(demotedData.admin).toBe(false);
  expect(demotedData.leader).toBe(false);
  await admin.dispose();
});

test("player administration, profile photos, friendly matches and Man of the Match voting", async ({playwright})=>{
  const admin=await playwright.request.newContext({baseURL:"http://localhost:3100"});
  const player=await playwright.request.newContext({baseURL:"http://localhost:3100"});
  const spectator=await playwright.request.newContext({baseURL:"http://localhost:3100"});
  const signin=async(ctx:typeof admin,p:{email:string})=>ctx.post("/api/auth/sign-in/email",{data:{email:p.email,password},headers:{origin:"http://localhost:3100"}});
  expect((await signin(admin,testPlayers[0])).status()).toBe(200);
  expect((await signin(player,testPlayers[1])).status()).toBe(200);
  expect((await signin(spectator,testPlayers[2])).status()).toBe(200);
  const headers={origin:"http://localhost:3100"};
  const added=await admin.post("/api/team",{headers,data:{type:"rosterPlayer",name:"QA Added Player",number:9,position:"Back"}});
  expect(added.status(),await added.text()).toBe(200);
  let team=await (await admin.get("/api/team")).json();
  expect(team.players.some((p:{name:string})=>p.name==="QA Added Player")).toBe(true);
  const renamed=await admin.post("/api/team",{headers,data:{type:"rosterPlayer",playerId:"qa-player",name:"QA Player Updated",number:12,position:"Anfallare"}});
  expect(renamed.status()).toBe(200);
  team=await (await admin.get("/api/team")).json();
  expect(team.players.find((p:{id:string})=>p.id==="qa-player").name).toBe("QA Player Updated");
  await admin.post("/api/team",{headers,data:{type:"rosterPlayer",playerId:"qa-player",name:"QA Player",number:null,position:"Allround"}});
  const promoted=await admin.post("/api/team",{headers,data:{type:"teamAdmin",playerId:"qa-player",enabled:true}});
  expect(promoted.status()).toBe(200);
  team=await (await admin.get("/api/team")).json();
  expect(team.players.find((p:{id:string})=>p.id==="qa-player").admin).toBe(true);
  expect((await admin.post("/api/team",{headers,data:{type:"teamAdmin",playerId:"qa-player",enabled:false}})).status()).toBe(200);
  expect((await admin.post("/api/team",{headers,data:{type:"teamAdmin",playerId:"qa-admin",enabled:false}})).status()).toBe(409);
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0y8AAAAASUVORK5CYII=","base64");
  const photo=await admin.post("/api/player-photo",{headers,multipart:{playerId:"qa-player",photo:{name:"avatar.png",mimeType:"image/png",buffer:png}}});
  expect(photo.status(),await photo.text()).toBe(200);
  expect((await admin.get("/api/player-photo?id=qa-player")).status()).toBe(200);
  expect((await admin.post("/api/player-photo",{headers,multipart:{playerId:"qa-player",remove:"1"}})).status()).toBe(200);
  const makeMatch=async(opponent:string,homeScore:number|null=null,awayScore:number|null=null)=>{
    const response=await admin.post("/api/team",{headers,data:{type:"friendlyMatch",opponent,startsAt:new Date(Date.now()-86400000).toISOString(),homeScore,awayScore}});
    expect(response.status(),await response.text()).toBe(200);
    const current=await (await admin.get("/api/team")).json();
    const found=current.friendlyMatches.find((m:{away:string})=>m.away===opponent);
    friendlyIds.push(found.id); return found.id as number;
  };
  const matchId=await makeMatch("QA Friendly",2,1);
  const secondMatch=await makeMatch("QA Friendly 2");
  let matches=(await (await admin.get("/api/team")).json()).friendlyMatches;
  expect(matches.find((m:{id:number})=>m.id===matchId)).toMatchObject({homeScore:2,awayScore:1});
  expect((await admin.post("/api/team",{headers,data:{type:"friendlyMatch",matchId,opponent:"QA Friendly",startsAt:new Date(Date.now()-86400000).toISOString(),homeScore:4,awayScore:3}})).status()).toBe(200);
  matches=(await (await admin.get("/api/team")).json()).friendlyMatches;
  expect(matches.find((m:{id:number})=>m.id===matchId)).toMatchObject({homeScore:4,awayScore:3});
  expect((await admin.post("/api/match-votes",{headers,data:{type:"open",matchId:secondMatch}})).status()).toBe(409);
  const marked=await admin.post("/api/team",{headers,data:{type:"presence",matchId,players:[{playerId:"qa-admin",status:"played"},{playerId:"qa-player",status:"played"},{playerId:"qa-spectator",status:"spectator"}]}});
  expect(marked.status()).toBe(200);
  expect((await admin.post("/api/match-votes",{headers,data:{type:"open",matchId}})).status()).toBe(200);
  expect((await player.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-admin",ratings:[{playerId:"qa-player",stars:5}]}})).status()).toBe(400);
  expect((await player.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-admin",ratings:[{playerId:"qa-spectator",stars:5}]}})).status()).toBe(400);
  expect((await player.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-admin",ratings:[{playerId:"qa-admin",stars:4}]}})).status()).toBe(200);
  expect((await spectator.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:null,ratings:[{playerId:"qa-player",stars:5}]}})).status()).toBe(200);
  expect((await admin.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-player",ratings:[{playerId:"qa-player",stars:2}]}})).status()).toBe(200);
  expect((await admin.post("/api/match-votes",{headers,data:{type:"close",matchId}})).status()).toBe(200);
  const votes=await (await admin.get(`/api/match-votes?matchId=${matchId}`)).json();
  expect(votes.closed).toBe(true);
  expect(votes.winnerId).toBe("qa-player"); // Tie on MOTM votes; qa-player gave more stars.
  expect(votes.ratings.find((r:{playerId:string})=>r.playerId==="qa-admin")).toMatchObject({average:4});
  expect(votes.ratings.find((r:{playerId:string})=>r.playerId==="qa-player")).toMatchObject({average:3.5});
  expect(votes.ratings.some((r:{count?:number})=>r.count!==undefined)).toBe(false);
  expect((await player.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-admin",ratings:[{playerId:"qa-admin",stars:1}]}})).status()).toBe(409);
  expect((await admin.post("/api/match-votes",{headers,data:{type:"open",matchId}})).status()).toBe(200);
  const reopened=await (await spectator.get(`/api/match-votes?matchId=${matchId}`)).json();
  expect(reopened).toMatchObject({open:true,closed:false});
  expect((await spectator.post("/api/match-votes",{headers,data:{type:"vote",matchId,motmPlayerId:"qa-admin",ratings:[{playerId:"qa-player",stars:3}]}})).status()).toBe(200);
  expect((await admin.post("/api/match-votes",{headers,data:{type:"close",matchId}})).status()).toBe(200);
  const revised=await (await admin.get(`/api/match-votes?matchId=${matchId}`)).json();
  expect(revised.ratings.find((r:{playerId:string})=>r.playerId==="qa-player")).toMatchObject({average:3});
  expect(revised.winnerId).toBe("qa-admin");
  expect(revised.ratings.find((r:{playerId:string;count?:number})=>r.playerId==="qa-player").count).toBeUndefined();
  expect(revised.motm).toBeUndefined();
  const seasonWithFriendly=await (await admin.get("/api/team")).json();
  expect(seasonWithFriendly.seasonRatings.find((r:{playerId:string})=>r.playerId==="qa-player")).toMatchObject({average:3,matches:1});
  expect(seasonWithFriendly.ratings.some((r:{count?:number})=>r.count!==undefined)).toBe(false);
  const corrected=await admin.post("/api/team",{headers,data:{type:"presence",matchId,players:[{playerId:"qa-admin",status:"played"},{playerId:"qa-player",status:"absent"},{playerId:"qa-spectator",status:"spectator"}]}});
  expect(corrected.status()).toBe(200);
  const afterCorrection=await (await admin.get(`/api/match-votes?matchId=${matchId}`)).json();
  expect(afterCorrection.ratings.some((r:{playerId:string})=>r.playerId==="qa-admin")).toBe(false);
  const stats=await (await admin.get("/api/team")).json();
  expect(stats.seasonRatings.find((r:{playerId:string})=>r.playerId==="qa-admin")).toMatchObject({motm:1,matches:0});
  expect(stats.seasonRatings.find((r:{playerId:string})=>r.playerId==="qa-player")).toBeUndefined();
  expect((await admin.post("/api/match-votes",{headers,data:{type:"delete",matchId}})).status()).toBe(200);
  const removedBallot=await (await admin.get(`/api/match-votes?matchId=${matchId}`)).json();
  expect(removedBallot).toMatchObject({open:false,closed:false,winnerId:null});
  expect(removedBallot.ratings).toEqual([]);
  expect((await admin.post("/api/team",{headers,data:{type:"deleteFriendlyMatch",matchId:secondMatch}})).status()).toBe(200);
  expect((await (await admin.get("/api/team")).json()).friendlyMatches.some((m:{id:number})=>m.id===secondMatch)).toBe(false);
  await Promise.all([admin.dispose(),player.dispose(),spectator.dispose()]);
});
