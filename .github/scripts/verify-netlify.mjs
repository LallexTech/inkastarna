const {
  NETLIFY_AUTH_TOKEN: token,
  NETLIFY_SITE_ID: siteId,
  DEPLOY_SHA: sha,
  DEPLOY_BRANCH: branch,
} = process.env;
if (!token || !siteId || !sha || !branch)
  throw new Error("Netlify CI configuration is missing");
const base = `https://api.netlify.com/api/v1/sites/${siteId}`;
async function api(path, method = "GET") {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Netlify API responded ${response.status}`);
  return response.json();
}
const deadline = Date.now() + 10 * 60_000;
let requested = false;
while (Date.now() < deadline) {
  const deployments = await api("/deploys?per_page=100");
  const deployment = deployments.find(
    (d) => d.commit_ref === sha && d.branch === branch,
  );
  if (deployment?.state === "ready") {
    console.log(
      `Netlify verified commit ${sha.slice(0, 8)}: ${deployment.deploy_ssl_url}`,
    );
    process.exit(0);
  }
  if (["error", "rejected"].includes(deployment?.state))
    throw new Error("Netlify build failed. Review the deployment build log.");
  // Native Git hooks normally start the build. This also supports the first
  // migration PR before Netlify has processed its first Git webhook.
  if (!deployment && !requested && branch !== "main") {
    await api(
      `/builds?branch=${encodeURIComponent(branch)}&commit_sha=${sha}&draft=true`,
      "POST",
    );
    requested = true;
  }
  console.log(`Waiting for Netlify: ${deployment?.state ?? "queued"}`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
throw new Error("Timed out waiting for Netlify deployment");
