import { timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import { appOrigins, appBaseUrl } from "./app-url";
export { appOrigins } from "./app-url";

export function validTeamCode(value: unknown, admin = false) {
  const expected = admin
    ? process.env.ADMIN_JOIN_CODE
    : process.env.TEAM_JOIN_CODE;
  if (!expected || typeof value !== "string") return false;
  const a = Buffer.from(value.trim()),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const auth = betterAuth({
  appName: "Inkastarna",
  database: db,
  baseURL: appBaseUrl(),
  trustedOrigins: appOrigins(),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 30,
    customRules: {
      "/sign-up/email": { window: 60, max: 5 },
      "/sign-in/email": { window: 60, max: 10 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/sign-up/email" &&
        !validTeamCode(
          ctx.headers?.get("x-team-code"),
          isAdmin(String(ctx.body?.email ?? "")),
        )
      ) {
        throw new APIError("FORBIDDEN", {
          message: "Lagkoden stämmer inte. Be lagledaren om en inbjudan.",
        });
      }
      if (ctx.path === "/sign-up/email") {
        if (
          process.env.ADMIN_PLAYER_NAME &&
          String(ctx.body?.name ?? "")
            .trim()
            .toLowerCase() === process.env.ADMIN_PLAYER_NAME.toLowerCase() &&
          !isAdmin(String(ctx.body?.email ?? ""))
        )
          throw new APIError("FORBIDDEN", {
            message: "Den spelarprofilen är reserverad för lagadministratören.",
          });
        const player = await db.query(
          "SELECT id,name FROM roster WHERE lower(name)=lower($1) AND user_id IS NULL",
          [String(ctx.body?.name ?? "").trim()],
        );
        if (!player.rowCount)
          throw new APIError("BAD_REQUEST", {
            message: "Välj en spelare i truppen som inte redan har ett konto.",
          });
        return {
          context: { ...ctx, body: { ...ctx.body, name: player.rows[0].name } },
        };
      }
      if (ctx.path === "/update-user" && ctx.body?.name !== undefined)
        throw new APIError("FORBIDDEN", {
          message: "Be lagledaren om hjälp med namnbyte.",
        });
    }),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await db.query(
            "UPDATE roster SET user_id=$1 WHERE lower(name)=lower($2) AND user_id IS NULL",
            [user.id, user.name],
          );
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export function isAdmin(email: string) {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(email.toLowerCase());
}

export async function isTeamLeader(userId: string, email: string) {
  if (isAdmin(email)) return true;
  const result = await db.query("SELECT 1 FROM team_leader WHERE user_id=$1", [
    userId,
  ]);
  return Boolean(result.rowCount);
}
