const REPO = "phuongnm7/Iptv-phuongnm7";
const WORKFLOW = "fpt-event-scan.yml";
const BRANCH = "main";
const STATUS_URL = "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/generated/fpt-event-live.status.json";
const STALE_AFTER_MS = 8 * 60 * 1000;
const API_VERSION = "2026-03-10";
const ACTIVE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

function ghHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "NM7-FPT-Event-Watchdog/2.0",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function gh(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...ghHeaders(token), ...(options.headers || {}) },
  });
  const bodyText = await response.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; }
  catch { body = { raw: bodyText.slice(0, 500) }; }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${body?.message || body?.raw || "error"}`);
  }
  return body;
}

async function latestRun(token) {
  const url = new URL(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`);
  url.searchParams.set("branch", BRANCH);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("exclude_pull_requests", "true");
  const data = await gh(url.toString(), token);
  return Array.isArray(data?.workflow_runs) ? (data.workflow_runs[0] || null) : null;
}

async function latestScanStatus() {
  const response = await fetch(`${STATUS_URL}?_=${Date.now()}`, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
      Accept: "application/json",
      "User-Agent": "NM7-FPT-Event-Watchdog/2.0",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`scanner-status-http-${response.status}`);
  return response.json();
}

async function dispatch(token) {
  if (!token) throw new Error("Missing Cloudflare secret GITHUB_TOKEN");
  await gh(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: BRANCH }),
  });
}

function ageMinutes(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 60000));
}

async function check(env) {
  if (!env.GITHUB_TOKEN) throw new Error("Missing Cloudflare secret GITHUB_TOKEN");

  const [run, scan] = await Promise.all([latestRun(env.GITHUB_TOKEN), latestScanStatus()]);
  const runAgeMs = run?.created_at ? Date.now() - Date.parse(run.created_at) : Infinity;
  const runAgeMinutes = Number.isFinite(runAgeMs) ? Math.max(0, Math.round(runAgeMs / 60000)) : null;
  const scanAgeMinutes = ageMinutes(scan?.generatedAt);
  const scanFresh = scanAgeMinutes !== null && scanAgeMinutes < 8;
  const validCandidateCount = Number(scan?.candidates) === 46;
  const validPublishedScan = Boolean(scan?.scanHealthy === true || (scan?.partialScan === true && Number(scan?.liveEntries) > 0));
  const activeRun = Boolean(run && ACTIVE.has(run.status));

  const diagnostics = {
    latest_run_id: run?.id ?? null,
    latest_run_status: run?.status ?? null,
    latest_run_conclusion: run?.conclusion ?? null,
    latest_run_age_minutes: runAgeMinutes,
    scan_generated_at: scan?.generatedAt ?? null,
    scan_age_minutes: scanAgeMinutes,
    scan_healthy: scan?.scanHealthy ?? null,
    partial_scan: scan?.partialScan ?? null,
    candidates: Number(scan?.candidates ?? 0),
    live_entries: Number(scan?.liveEntries ?? 0),
    probe_errors: Number(scan?.probeErrors ?? 0),
    source_only: scan?.sourceOnly ?? null,
  };

  if (activeRun && runAgeMs < STALE_AFTER_MS && scanFresh && validCandidateCount && validPublishedScan) {
    return { action: "noop", reason: "recent_run_and_fresh_scan", ...diagnostics };
  }

  if (activeRun) {
    return { action: "noop", reason: "workflow_still_active", ...diagnostics };
  }

  if (run && runAgeMs < STALE_AFTER_MS && scanFresh && validCandidateCount && validPublishedScan) {
    return { action: "noop", reason: "recent_completed_run_and_fresh_scan", ...diagnostics };
  }

  await dispatch(env.GITHUB_TOKEN);
  return {
    action: "dispatch",
    reason: !run ? "no_previous_run" : (!scanFresh ? "scanner_output_stale" : (!validCandidateCount ? "unexpected_candidate_count" : (!validPublishedScan ? "invalid_scan_state" : "latest_run_older_than_8_minutes"))),
    previous_run_id: run?.id ?? null,
    previous_status: run?.status ?? null,
    previous_conclusion: run?.conclusion ?? null,
    previous_age_minutes: runAgeMinutes,
    ...diagnostics,
  };
}

export default {
  async scheduled(controller, env) {
    const result = await check(env);
    console.log(JSON.stringify({
      service: "nm7-fpt-event-watchdog",
      cron: controller.cron,
      scheduled_at: new Date(controller.scheduledTime).toISOString(),
      ...result,
    }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "nm7-fpt-event-watchdog",
        schedule: "*/5 * * * *",
        targetWorkflow: WORKFLOW,
        staleAfterMinutes: 8,
        tokenConfigured: Boolean(env.GITHUB_TOKEN),
      });
    }

    if (url.pathname === "/run") {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      try {
        return Response.json({ ok: true, service: "nm7-fpt-event-watchdog", ...(await check(env)) });
      } catch (error) {
        return Response.json({
          ok: false,
          service: "nm7-fpt-event-watchdog",
          error: error instanceof Error ? error.message : String(error),
        }, { status: 502 });
      }
    }

    return new Response("NM7 FPT Event Watchdog\n\n/health\nPOST /run\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
