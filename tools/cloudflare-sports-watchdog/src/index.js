const REPO = "phuongnm7/Iptv-phuongnm7";
const WORKFLOW = "update-sports-auto.yml";
const BRANCH = "main";
const STALE_AFTER_MS = 8 * 60 * 1000;
const API_VERSION = "2026-03-10";

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);

function githubHeaders(token) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "NM7-Sports-Watchdog/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...githubHeaders(token), ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const detail = body?.message || body?.raw || `HTTP ${response.status}`;
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return body;
}

async function listRecentRuns(token) {
  const url = new URL(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`,
  );
  url.searchParams.set("branch", BRANCH);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("exclude_pull_requests", "true");
  return githubJson(url.toString(), token);
}

async function dispatchWorkflow(token) {
  if (!token) throw new Error("Missing required Cloudflare Worker secret: GITHUB_TOKEN");
  return githubJson(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ ref: BRANCH, return_run_details: true }),
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function runWatchdog(env) {
  const now = Date.now();
  const data = await listRecentRuns(env.GITHUB_TOKEN);
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  const latest = runs[0] || null;

  if (!latest) {
    const dispatched = await dispatchWorkflow(env.GITHUB_TOKEN);
    return {
      action: "dispatch",
      reason: "no_previous_run",
      workflow_run_id: dispatched?.workflow_run_id ?? null,
    };
  }

  const createdAt = Date.parse(latest.created_at);
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : Infinity;

  if (ageMs < STALE_AFTER_MS) {
    return {
      action: "noop",
      reason: "recent_run",
      run_id: latest.id,
      status: latest.status,
      conclusion: latest.conclusion,
      age_minutes: Math.round(ageMs / 60000),
    };
  }

  if (ACTIVE_STATUSES.has(latest.status)) {
    return {
      action: "noop",
      reason: "workflow_still_active",
      run_id: latest.id,
      status: latest.status,
      age_minutes: Math.round(ageMs / 60000),
    };
  }

  const dispatched = await dispatchWorkflow(env.GITHUB_TOKEN);
  return {
    action: "dispatch",
    reason: "latest_run_older_than_8_minutes",
    previous_run_id: latest.id,
    previous_status: latest.status,
    previous_conclusion: latest.conclusion,
    previous_age_minutes: Math.round(ageMs / 60000),
    workflow_run_id: dispatched?.workflow_run_id ?? null,
  };
}

export default {
  async scheduled(controller, env) {
    const result = await runWatchdog(env);
    console.log(JSON.stringify({
      cron: controller.cron,
      scheduled_at: new Date(controller.scheduledTime).toISOString(),
      ...result,
    }));
  },

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        service: "nm7-sports-watchdog",
        schedule: "*/5 * * * *",
        stale_after_minutes: 8,
      }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("NM7 Sports Watchdog is running.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
