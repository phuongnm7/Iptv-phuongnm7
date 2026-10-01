const SOURCE_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u";
const GENERATED_PLAYLIST_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/generated/fpt-event-live.m3u";
const PLAYLIST_KEY = "fpt:live:playlist";
const GENERATED_AT_KEY = "fpt:live:generatedAt";
const STATUS_KEY = "fpt:live:status";
const GROUP = "SỰ KIỆN FPT";
const CRON = "*/5 * * * *";
const WORKER_VERSION = "fpt-event-source-mirror-v13";
const CACHE_TTL = 24 * 60 * 60;

function countEntries(text) {
  return text.match(/^#EXTINF:/gm)?.length || 0;
}

function extractUrls(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

function hasManifestUrls(text) {
  return countEntries(text) > 0;
}

function buildEmpty() {
  return "#EXTM3U\n";
}

async function fetchGeneratedPlaylist() {
  const bust = Date.now();
  return fetch(
    `${GENERATED_PLAYLIST_URL}?_=${bust}`,
    {
      method: "GET",
      headers: {
        "User-Agent": "NM7-FPT-Event-Worker/13",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
        Accept: "application/x-mpegURL,text/plain,*/*",
      },
      cache: "no-store",
    }
  );
}

async function validateAgainstSource(playlistText) {
  const sourceResponse = await fetch(
    `${SOURCE_URL}?_=${Date.now()}`,
    {
      headers: {
        "User-Agent": "NM7-FPT-Event-Worker/13",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
      cache: "no-store",
    }
  );

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
    throw new Error(
      `source-integrity-failed:${validation.reason}`
    );
  }

  const generatedAt = new Date().toISOString();
  await env.FPT_EVENT_KV.put(PLAYLIST_KEY, text);
  await env.FPT_EVENT_KV.put(GENERATED_AT_KEY, generatedAt);

  const verifiedMarker =
    /#NM7-SCAN-VERIFIED:\s*true/i.test(text);
  const userConfirmedMarker =
    /#NM7-SCAN-VERIFIED:\s*user-confirmed/i.test(text);

  const status = {
    service: "NM7 FPT Event Live",
    workerVersion: WORKER_VERSION,
    sourceOnly: true,
    sourceUrl: SOURCE_URL,
    generatedPlaylistUrl: GENERATED_PLAYLIST_URL,
    scheduler: {
      cron: CRON,
      strategy:
        "GitHub Actions scans exact source URLs through a Vietnam transport path every 5 minutes; Worker only mirrors the generated exact-source live set",
    },
    generatedAt,
    trigger,
    candidates: validation.sourceUrlCount,
    liveEntries: countEntries(text),
    playlistEntries: countEntries(text),
    verified: verifiedMarker,
    userConfirmed: userConfirmedMarker,
    validation,
  };

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: CACHE_TTL,
  });

  return { text, status };
}

async function getCached(env) {
  const [playlist, generatedAt, statusText] = await Promise.all([
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
    generatedAt,
    status,
  };
}

function playlistResponse(text, status, source = "github-generated") {
  const verified = /#NM7-SCAN-VERIFIED:\s*true/i.test(text);
  const userConfirmed = /#NM7-SCAN-VERIFIED:\s*user-confirmed/i.test(text);
  const entries = countEntries(text);

  return new Response(text, {
    headers: {
      "Content-Type": "application/x-mpegURL; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-NM7-FPT-Events": String(entries),
      "X-NM7-FPT-Verified": String(verified),
      "X-NM7-FPT-User-Confirmed": String(userConfirmed),
      "X-NM7-FPT-Filter":
        verified
          ? "source-current-live-only"
          : userConfirmed
          ? "source-user-confirmed-awaiting-scan"
          : "source-current-scan-unverified",
      "X-NM7-FPT-Source-Only": "true",
      "X-NM7-FPT-Version": WORKER_VERSION,
      "X-NM7-FPT-Source": source,
      "X-NM7-FPT-Generated-At":
        status?.generatedAt || new Date().toISOString(),
    },
  });
}

export default {
  async scheduled(controller, env) {
    try {
      await refreshCache(env, "cron");
    } catch (error) {
      const cached = await getCached(env);
      const status = {
        ...(cached.status || {}),
        service: "NM7 FPT Event Live",
        workerVersion: WORKER_VERSION,
        sourceOnly: true,
        sourceUrl: SOURCE_URL,
        generatedPlaylistUrl: GENERATED_PLAYLIST_URL,
        scheduler: { cron: CRON },
        generatedAt: cached.generatedAt,
        lastError: error instanceof Error ? error.message : String(error),
        trigger: "cron",
        cachedEntries: countEntries(cached.playlist),
        cacheOnly: true,
      };
      await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
        expirationTtl: CACHE_TTL,
      });
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname === "/fpt-event-live.m3u" ||
      url.pathname === "/fpt-event-fallback.m3u"
    ) {
      try {
        const current = await refreshCache(env, "http");
        return playlistResponse(current.text, current.status);
      } catch {
        const cached = await getCached(env);
        return playlistResponse(
          cached.playlist,
          cached.status,
          "kv-cache"
        );
      }
    }

    if (url.pathname === "/status") {
      try {
        const current = await refreshCache(env, "status");
        return Response.json(current.status);
      } catch (error) {
        const cached = await getCached(env);
        return Response.json({
          ...(cached.status || {}),
          service: "NM7 FPT Event Live",
          workerVersion: WORKER_VERSION,
          sourceOnly: true,
          generatedPlaylistUrl: GENERATED_PLAYLIST_URL,
          cacheOnly: true,
          lastError: error instanceof Error ? error.message : String(error),
          cachedEntries: countEntries(cached.playlist),
          scheduler: {
            cron: CRON,
            strategy:
              "GitHub Actions scans exact source URLs through a Vietnam transport path every 5 minutes; Worker mirrors the resulting exact-source set",
          },
        });
      }
    }

    if (url.pathname === "/scan") {
      const cached = await getCached(env);
      return Response.json({
        ...(cached.status || {}),
        service: "NM7 FPT Event Live",
        workerVersion: WORKER_VERSION,
        sourceOnly: true,
        requested: true,
        message:
          "Direct FPT scanning is intentionally performed by the GitHub Actions Vietnam scanner. The next scheduled scan runs every 5 minutes.",
        cachedEntries: countEntries(cached.playlist),
      });
    }

    return new Response(
      "NM7 FPT Event Live\n\n/fpt-event-live.m3u\n/status\n/scan\n",
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  },
};
