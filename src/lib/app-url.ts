function deploymentEnvironment() {
  // Netlify provides these public URLs during the build. Its functions do not
  // necessarily receive the same system variables at runtime.
  return {
    ...process.env,
    DEPLOY_PRIME_URL:
      process.env.DEPLOY_PRIME_URL || process.env.INKASTARNA_DEPLOY_PRIME_URL,
    DEPLOY_URL: process.env.DEPLOY_URL || process.env.INKASTARNA_DEPLOY_URL,
  };
}

export function appOrigins(
  env: Record<string, string | undefined> = deploymentEnvironment(),
) {
  return [
    ...new Set(
      [
        ...(!env.VERCEL && !env.NETLIFY && !env.DEPLOY_URL && !env.URL
          ? ["http://localhost:3000"]
          : []),
        env.BETTER_AUTH_URL,
        env.URL,
        env.DEPLOY_URL,
        env.DEPLOY_PRIME_URL,
        env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined,
        env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : undefined,
      ].filter((x): x is string => Boolean(x)),
    ),
  ];
}

export function appBaseUrl(
  env: Record<string, string | undefined> = deploymentEnvironment(),
) {
  // A Netlify branch or PR preview must use its own origin and cookies. The
  // deploy URL is provided by Netlify, never from an untrusted request Host.
  if (
    (env.NETLIFY === "true" || env.DEPLOY_PRIME_URL) &&
    env.CONTEXT !== "production"
  ) {
    return (
      env.DEPLOY_PRIME_URL ||
      env.DEPLOY_URL ||
      env.BETTER_AUTH_URL ||
      "http://localhost:3000"
    );
  }
  return (
    env.BETTER_AUTH_URL ||
    (env.NETLIFY === "true" ? env.URL : undefined) ||
    (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "http://localhost:3000")
  );
}
