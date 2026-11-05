import test from "node:test";
import assert from "node:assert/strict";
import { appOrigins, appBaseUrl } from "../src/lib/app-url";

test("Netlify pre and PR previews use their own exact origin", () => {
  const env = {
    NETLIFY: "true",
    CONTEXT: "branch-deploy",
    URL: "https://inkastarna.netlify.app",
    DEPLOY_PRIME_URL: "https://pre--inkastarna.netlify.app",
    DEPLOY_URL: "https://deploy-id--inkastarna.netlify.app",
    BETTER_AUTH_URL: "https://inkastarna.netlify.app",
  };
  assert.equal(appBaseUrl(env), env.DEPLOY_PRIME_URL);
  assert.deepEqual(appOrigins(env), [
    env.BETTER_AUTH_URL,
    env.DEPLOY_URL,
    env.DEPLOY_PRIME_URL,
  ]);
  assert.equal(
    appOrigins(env).includes("https://unrelated.netlify.app"),
    false,
  );
  assert.equal(appOrigins(env).includes("http://localhost:3000"), false);
});
test("Netlify production uses configured public address", () => {
  assert.equal(
    appBaseUrl({
      NETLIFY: "true",
      CONTEXT: "production",
      URL: "https://inkastarna.netlify.app",
    }),
    "https://inkastarna.netlify.app",
  );
});
test("local development keeps its configured address", () => {
  assert.equal(
    appBaseUrl({ BETTER_AUTH_URL: "http://localhost:3100" }),
    "http://localhost:3100",
  );
});
