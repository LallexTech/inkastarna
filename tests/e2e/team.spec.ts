import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import fixture from "../fixtures/league.json" with { type: "json" };

const password = randomBytes(24).toString("hex");
const sql = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const testPlayers = [
  { id: "qa-admin", name: "QA Admin", email: "qa-admin@inkastarna.invalid" },
  { id: "qa-player", name: "QA Player", email: "qa-player@inkastarna.invalid" },
];

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
      "INSERT INTO roster(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [p.id, p.name],
    );
});
test.afterAll(async () => {
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
  await admin.dispose();
});
