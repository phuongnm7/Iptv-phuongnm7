const SOURCE_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u";
const GENERATED_PLAYLIST_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/generated/fpt-event-live.m3u";
const PLAYLIST_KEY = "fpt:live:playlist";
const GENERATED_AT_KEY = "fpt:live:generatedAt";
const STATUS_KEY = "fpt:live:status";
const SCANNER_HEALTH_KEY = "fpt:live:scanner-health";
const GROUP = "SỰ KIỆN FPT";
const CRON = "*/5 * * * *";
const WORKER_VERSION = "fpt-event-source-mirror-v14";
const CACHE_TTL = 24 * 60 * 60;
const REQUEST_REFRESH_AFTER = 4 * 60;
const SCANNER_HEALTH_TTL = 60;
const SCANNER_WORKFLOW_URL =
  "https://api.github.com/repos/phuongnm7/Iptv-phuongnm7/actions/workflows/scan-fpt-events.yml/runs?branch=main&per_page=10";

function countEntries(text) {
  return text.match(/^#EXTINF:/gm)?.length || 0;
}

function extractUrls(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

function buildEmpty() {
  return "#EXTM3U\n";
}

async function fetchGeneratedPlaylist() {
  const bust = Date.now();
  return fetch(`${GENERATED_PLAYLIST_URL}?_=${bust}`, {
    method: "GET",
    headers: {
      "User-Agent": "NM7-FPT-Event-Worker/14",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
      Accept: "application/x-mpegURL,text/plain,*/*",
    },
    cache: "no-store",
  });
}

async function validateAgainstSource(playlistText) {
  const sourceResponse = await fetch(`${SOURCE_URL}?_=${Date.now()}`, {
    headers: {
      "User-Agent": "NM7-FPT-Event-Worker/14",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
    cache: "no-store",
  });

  if (!sourceResponse.ok) {
    return {
      ok: false,
      sourceReachable: false,
      reason: `source-http-${sourceResponse.status}`,
    };
  }

  const sourceText = await sourceResponse.text();
  const sourceUrls = new Set(extractUrls(sourceText));
  const outputUrls = extractUrls(playlistText);
  const invalid = outputUrls.filter((url) => !sourceUrls.has(url));

  return {
    ok: invalid.length === 0,
    sourceReachable: true,
    sourceUrlCount: sourceUrls.size,
    outputUrlCount: outputUrls.length,
    invalidUrls: invalid.slice(0, 10),
    reason: invalid.length ? "output-url-not-in-source" : "ok",
  };
}

async function fetchScannerHealth(env, force = false) {
  if (!force) {
    const cached = await env.FPT_EVENT_KV.get(SCANNER_HEALTH_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        const age = (Date.now() - Date.parse(parsed.checkedAt || 0)) / 1000;
        if (Number.isFinite(age) && age < SCANNER_HEALTH_TTL) {
          return parsed;
        }
      } catch {
        // Refresh below.
      }
    }
  }

  try {
    const response = await fetch(SCANNER_WORKFLOW_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "NM7-FPT-Event-Worker/14",
        "Cache-Control": "no-cache",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`github-actions-http-${response.status}`);
    }

    const data = await response.json();
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const latest = runs[0] || null;
    const lastSuccess =
      runs.find((run) => run.conclusion === "success") || null;
    const checkedAt = new Date().toISOString();
    const lastRunAt = latest?.updated_at || latest?.run_started_at || null;
    const lastSuccessAt =
      lastSuccess?.updated_at || lastSuccess?.run_started_at || null;
    const ageSeconds = lastSuccessAt
      ? Math.max(0, (Date.now() - Date.parse(lastSuccessAt)) / 1000)
      : null;

    const result = {
      available: true,
      workflow: "scan-fpt-events.yml",
      workflowUrl: SCANNER_WORKFLOW_URL,
      checkedAt,
      latestRun: latest
        ? {
            id: latest.id,
            status: latest.status,
            conclusion: latest.conclusion,
            event: latest.event,
            createdAt: latest.created_at,
            updatedAt: latest.updated_at,
          }
        : null,
      lastSuccessfulRun: lastSuccess
        ? {
            id: lastSuccess.id,
            status: lastSuccess.status,
            conclusion: lastSuccess.conclusion,
            createdAt: lastSuccess.created_at,
            updatedAt: lastSuccess.updated_at,
          }
        : null,
      lastRunAt,
      lastSuccessAt,
      lastSuccessAgeSeconds: ageSeconds,
      healthy:
        Boolean(lastSuccessAt) &&
        Number.isFinite(ageSeconds) &&
        ageSeconds <= 15 * 60 &&
        latest?.conclusion !== "failure",
    };

    await env.FPT_EVENT_KV.put(
      SCANNER_HEALTH_KEY,
      JSON.stringify(result),
      { expirationTtl: SCANNER_HEALTH_TTL + 30 }
    );
    return result;
  } catch (error) {
    const fallback = {
      available: false,
      checkedAt: new Date().toISOString(),
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
    await env.FPT_EVENT_KV.put(
      SCANNER_HEALTH_KEY,
      JSON.stringify(fallback),
      { expirationTtl: SCANNER_HEALTH_TTL }
    );
    return fallback;
  }
}

async function refreshCache(env, trigger = "cron") {
  const response = await fetchGeneratedPlaylist();
  if (!response.ok) {
    throw new Error(`generated-playlist-http-${response.status}`);
  }

  const text = await response.text();
  if (!text.includes("#EXTM3U")) {
    throw new Error("generated-playlist-is-not-m3u");
  }

  const validation = await validateAgainstSource(text);
  if (!validation.ok) {
    throw new Error(`source-integrity-failed:${validation.reason}`);
  }

  const cacheRefreshedAt = new Date().toISOString();
  await env.FPT_EVENT_KV.put(PLAYLIST_KEY, text);
  await env.FPT_EVENT_KV.put(GENERATED_AT_KEY, cacheRefreshedAt);

  const scannerHealth = await fetchScannerHealth(env, true);

  const status = {
    service: "NM7 FPT Event Live",
    workerVersion: WORKER_VERSION,
    sourceOnly: true,
    sourceUrl: SOURCE_URL,
    generatedPlaylistUrl: GENERATED_PLAYLIST_URL,
    scheduler: {
      cron: CRON,
      strategy:
        "Dedicated GitHub Actions Vietnam scanner runs every 5 minutes; Cloudflare Worker mirrors the exact-source live set",
    },
    workerCacheRefreshedAt: cacheRefreshedAt,
    trigger,
    candidates: validation.sourceUrlCount,
    liveEntries: countEntries(text),
    playlistEntries: countEntries(text),
    validation,
    scannerHealth,
    playlistVerified: /#NM7-SCAN-VERIFIED:\s*true/i.test(text),
  };

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: CACHE_TTL,
  });

  return { text, status };
}

async function getCached(env) {
  const [playlist, refreshedAt, statusText] = await Promise.all([
    env.FPT_EVENT_KV.get(PLAYLIST_KEY),
    env.FPT_EVENT_KV.get(GENERATED_AT_KEY),
    env.FPT_EVENT_KV.get(STATUS_KEY),
  ]);

  let status = null;
  if (statusText) {
    try {
      status = JSON.parse(statusText);
    } catch {
      status = null;
    }
  }

  return {
    playlist: playlist || buildEmpty(),
    refreshedAt,
    status,
  };
}

async function getCurrent(env, trigger = "http") {
  const cached = await getCached(env);
  const age = cached.refreshedAt
    ? Math.max(0, (Date.now() - Date.parse(cached.refreshedAt)) / 1000)
    : Infinity;

  if (cached.refreshedAt && age < REQUEST_REFRESH_AFTER) {
    return cached;
  }

  try {
    const current = await refreshCache(env, trigger);
    return {
      playlist: current.text,
      refreshedAt: current.status.workerCacheRefreshedAt,
      status: current.status,
    };
  } catch (error) {
    if (cached.status) {
      return {
        ...cached,
        status: {
          ...cached.status,
          cacheOnly: true,
          lastRefreshError:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
    throw error;
  }
}

function playlistResponse(text, status, source = "kv-cache") {
  const verified = /#NM7-SCAN-VERIFIED:\s*true/i.test(text);
  const entries = countEntries(text);
  const scanner = status?.scannerHealth || {};

  return new Response(text, {
    headers: {
      "Content-Type": "application/x-mpegURL; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-NM7-FPT-Events": String(entries),
      "X-NM7-FPT-Verified": String(verified),
      "X-NM7-FPT-Source-Only": "true",
      "X-NM7-FPT-Version": WORKER_VERSION,
      "X-NM7-FPT-Source": source,
      "X-NM7-FPT-Scanner-Healthy": String(Boolean(scanner.healthy)),
      "X-NM7-FPT-Scanner-Last-Success":
        scanner.lastSuccessAt || "",
      "X-NM7-FPT-Worker-Cache":
        status?.workerCacheRefreshedAt || "",
    },
  });
}

export default {
  async scheduled(controller, env) {
    try {
      await refreshCache(env, "cron");
    } catch (error) {
      const cached = await getCached(env);
      const scannerHealth = await fetchScannerHealth(env, true);
      const status = {
        ...(cached.status || {}),
        service: "NM7 FPT Event Live",
        workerVersion: WORKER_VERSION,
        sourceOnly: true,
        scheduler: { cron: CRON },
        trigger: "cron",
        scannerHealth,
        cacheOnly: true,
        cachedEntries: countEntries(cached.playlist),
        lastRefreshError:
          error instanceof Error ? error.message : String(error),
      };
      await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
        expirationTtl: CACHE_TTL,
      });
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/fpt-event-live.m3u") {
      try {
        const current = await getCurrent(env, "http-playlist");
        return playlistResponse(
          current.playlist,
          current.status,
          current.status?.cacheOnly ? "kv-cache" : "worker-refresh"
        );
      } catch (error) {
        return new Response(
          `#EXTM3U\n# NM7 FPT Worker error: ${error instanceof Error ? error.message : String(error)}\n`,
          {
            status: 502,
            headers: {
              "Content-Type": "application/x-mpegURL; charset=utf-8",
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*",
              "X-NM7-FPT-Version": WORKER_VERSION,
            },
          }
        );
      }
    }

    if (url.pathname === "/status") {
      try {
        const current = await refreshCache(env, "status");
        return Response.json(current.status);
      } catch (error) {
        const cached = await getCached(env);
        const scannerHealth = await fetchScannerHealth(env, true);
        return Response.json({
          ...(cached.status || {}),
          service: "NM7 FPT Event Live",
          workerVersion: WORKER_VERSION,
          sourceOnly: true,
          scheduler: { cron: CRON },
          scannerHealth,
          cacheOnly: true,
          lastRefreshError:
            error instanceof Error ? error.message : String(error),
          cachedEntries: countEntries(cached.playlist),
        });
      }
    }

    if (url.pathname === "/scan") {
      const scannerHealth = await fetchScannerHealth(env, true);
      const cached = await getCached(env);
      return Response.json({
        ...(cached.status || {}),
        service: "NM7 FPT Event Live",
        workerVersion: WORKER_VERSION,
        sourceOnly: true,
        requested: true,
        message:
          "FPT source scanning is performed by the dedicated GitHub Actions Vietnam scanner every 5 minutes; this endpoint reports scanner state and cached live set.",
        scannerHealth,
        cachedEntries: countEntries(cached.playlist),
      });
    }

    return new Response(
      "NM7 FPT Event Live\n\n/fpt-event-live.m3u\n/status\n/scan\n",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
