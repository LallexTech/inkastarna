import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/lib/auth";
import { db } from "../src/lib/db";

const migration = await getMigrations(auth.options);
await migration.runMigrations();
await db.query(`
  CREATE TABLE IF NOT EXISTS league_snapshot (
    id integer PRIMARY KEY CHECK (id=1), data jsonb NOT NULL, fetched_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS player_profile (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    number integer CHECK (number BETWEEN 1 AND 99), position text NOT NULL DEFAULT 'Allround'
  );
  CREATE TABLE IF NOT EXISTS attendance (
    match_id integer NOT NULL, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status text NOT NULL CHECK(status IN ('yes','maybe','no')), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(match_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS lineup (
    match_id integer PRIMARY KEY, slots jsonb NOT NULL, updated_by text NOT NULL REFERENCES "user"(id),
    updated_at timestamptz NOT NULL DEFAULT now(), CHECK(jsonb_array_length(slots)=5)
  );
  CREATE TABLE IF NOT EXISTS player_match_stats (
    match_id integer NOT NULL, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    goals integer NOT NULL DEFAULT 0 CHECK(goals>=0), assists integer NOT NULL DEFAULT 0 CHECK(assists>=0),
    played boolean NOT NULL DEFAULT false, PRIMARY KEY(match_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS roster (
    id text PRIMARY KEY, name text NOT NULL UNIQUE,
    user_id text UNIQUE REFERENCES "user"(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS player_stats (
    match_id integer NOT NULL, player_id text NOT NULL REFERENCES roster(id),
    goals integer NOT NULL DEFAULT 0 CHECK(goals>=0), assists integer NOT NULL DEFAULT 0 CHECK(assists>=0),
    played boolean NOT NULL DEFAULT false, PRIMARY KEY(match_id,player_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS unique_player_account_name ON "user"(lower(name));
`);
const initialRoster = (process.env.INITIAL_ROSTER ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
for (const name of initialRoster)
  await db.query(
    "INSERT INTO roster(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [name.toLowerCase(), name],
  );
console.log("Auth- och lagtabeller är uppdaterade.");
await db.end();
