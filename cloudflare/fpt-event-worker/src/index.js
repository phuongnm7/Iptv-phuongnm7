const GROUP = "SỰ KIỆN FPT";
const SOURCE_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u";
const PLAYLIST_KEY = "fpt:live:playlist";
const PUBLISHED_AT_KEY = "fpt:live:publishedAt";
const HEALTHY_CHANNELS_KEY = "fpt:live:healthyChannels";
const STATUS_KEY = "fpt:live:status";
const CRON = "*/5 * * * *";
const PLAYLIST_TTL = 60 * 60;
const DEGRADED_GRACE_MS = 15 * 60 * 1000;
const STATUS_TTL = 60 * 60;
const WORKER_VERSION = "fpt-event-resilient-v7-subrequest-safe";

// Cloudflare Workers Free: 50 external subrequests/invocation.
// This worker needs 1 request for SOURCE_URL + 46 primary probes today.
// Reserve one request as a safety margin; at most 2 fallback probes are allowed.
const MAX_EXTERNAL_SUBREQUESTS = 49;
const MAX_FALLBACK_PROBES = 2;
const MAX_CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 8000;

const UAS = ["VThanhTivi", "KhoaTivi", "BearTV"];
const RECOVERY_PROBE_LIMIT = 2;
const LAST_KNOWN_GOOD = [
  {
    name: "Sự kiện FPT 01",
    url: "https://vips-livecdn.fptplay.net/live/media/su-kien-01/hls_avc_v6/index.m3u8",
  },
  {
    name: "Sự kiện FPT 09",
    url: "https://vips-livecdn.fptplay.net/live/media/su-kien-09/hls_avc_v6/index.m3u8",
  },
  {
    name: "Sự kiện FPT 10",
    url: "https://vips-livecdn.fptplay.net/live/media/su-kien-10/hls_avc_v6/index.m3u8",
  },
  {
    name: "Sự kiện FPT Event 02",
    url: "https://vips-livecdn.fptplay.net/live/media/event-02/hls_avc_v6/index.m3u8",
  },
  {
    name: "Sự kiện FPT Event 07",
    url: "https://vips-livecdn.fptplay.net/live/media/event-07/hls_avc_v6/index.m3u8",
  },
];

function isDashUrl(url) {
  return /\.mpd(?:[?#]|$)/i.test(url || "");
}

function protocolFor(item, contentType = "") {
  return isDashUrl(item.url) || /application\/dash\+xml/i.test(contentType)
    ? "DASH"
    : "HLS";
}

function parseSource(text) {
  const lines = text.split(/\r?\n/);
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF")) continue;

    const comma = line.indexOf(",");
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "Sự kiện FPT";

    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith("#")) continue;
      if (/^https?:\/\//i.test(candidate)) {
        url = candidate;
        i = j;
      }
      break;
    }

    if (!url) continue;
    result.push({ name, url });
  }

  // Do not probe the exact same URL twice if the source accidentally duplicates it.
  const seen = new Set();
  return result.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function isLiveHls(text) {
  if (!text || !text.includes("#EXTM3U")) return false;
  if (text.includes("#EXT-X-ENDLIST")) return false;
  if (/^#EXT-X-PLAYLIST-TYPE:VOD\s*$/mi.test(text)) return false;

  const hasSegments = /(^|\n)#EXTINF:/m.test(text);
  const hasVariant = /(^|\n)#EXT-X-STREAM-INF:/m.test(text);
  const hasMediaSequence = /(^|\n)#EXT-X-MEDIA-SEQUENCE:/m.test(text);
  return hasSegments || hasVariant || hasMediaSequence;
}

function isLiveDash(text) {
  if (!text) return false;

  const xml = text.replace(/^\uFEFF/, "").trim();
  if (!/<MPD(?:\s|>)/i.test(xml)) return false;

  const typeMatch = xml.match(
    /<MPD\b[^>]*\btype\s*=\s*["']([^"']+)["']/i
  );

  // Explicit static MPD = VOD/on-demand.
  if (typeMatch && typeMatch[1].toLowerCase() === "static") return false;

  // FPT may omit type="dynamic", so accept other live-oriented MPD signals.
  const hasLiveSignal =
    (typeMatch && typeMatch[1].toLowerCase() === "dynamic") ||
    /\bminimumUpdatePeriod\s*=\s*["'][^"']+["']/i.test(xml) ||
    /\btimeShiftBufferDepth\s*=\s*["'][^"']+["']/i.test(xml) ||
    /\bavailabilityStartTime\s*=\s*["'][^"']+["']/i.test(xml) ||
    /\bsuggestedPresentationDelay\s*=\s*["'][^"']+["']/i.test(xml);

  if (!hasLiveSignal) return false;

  return (
    /<AdaptationSet\b/i.test(xml) ||
    /<Representation\b/i.test(xml) ||
    /<SegmentTemplate\b/i.test(xml) ||
    /<SegmentTimeline\b/i.test(xml)
  );
}

function timeoutSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function fetchWithBudget(url, options, budget) {
  if (budget.used >= MAX_EXTERNAL_SUBREQUESTS) {
    throw new Error(
      "Local subrequest safety budget exhausted before fetch (reserved Cloudflare margin)"
    );
  }

  budget.used += 1;
  return fetch(url, options);
}

async function probeOnce(item, ua, budget, targetUrl = item.url) {
  const { signal, cancel } = timeoutSignal();

  try {
    const response = await fetchWithBudget(
      targetUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": ua,
          Accept: isDashUrl(targetUrl)
            ? "application/dash+xml,application/xml,text/xml,*/*"
            : "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
          "Cache-Control": "no-cache, no-store",
          Pragma: "no-cache",
          Referer: "https://fptplay.vn/",
          Origin: "https://fptplay.vn",
          "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        cache: "no-store",
        redirect: "manual",
        signal,
      },
      budget
    );

    const contentType = response.headers.get("content-type") || "";
    const protocol = protocolFor({ ...item, url: targetUrl }, contentType);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || "";
      return {
        ...item,
        protocol,
        live: false,
        error: `HTTP ${response.status} redirect`,
        redirectUrl: location ? new URL(location, targetUrl).toString() : null,
        httpStatus: response.status,
        contentType,
        userAgent: ua,
      };
    }

    if (response.ok) {
      const body = await response.text();
      const live = protocol === "DASH" ? isLiveDash(body) : isLiveHls(body);

      // HTTP 200 with a non-manifest body is treated as a probe error, not as a clean
      // inactive stream. This prevents a transient block/HTML response from erasing
      // the entire published state.
      const validManifest =
        protocol === "DASH"
          ? /<MPD(?:\s|>)/i.test(body)
          : body.includes("#EXTM3U");

      if (!validManifest) {
        return {
          ...item,
          protocol,
          live: false,
          error: "HTTP 200 but manifest is invalid/non-M3U/non-MPD",
          inactiveReason: null,
          httpStatus: response.status,
          contentType,
          userAgent: ua,
        };
      }

      return {
        ...item,
        protocol,
        live,
        error: null,
        inactiveReason: live
          ? null
          : protocol === "DASH"
          ? "DASH MPD is not live"
          : "HLS playlist is not live",
        httpStatus: response.status,
        contentType,
        userAgent: ua,
      };
    }

    if (response.status === 404 || response.status === 410) {
      return {
        ...item,
        protocol,
        live: false,
        error: null,
        inactiveReason: `HTTP ${response.status}`,
        httpStatus: response.status,
        contentType,
        userAgent: ua,
      };
    }

    return {
      ...item,
      protocol,
      live: false,
      error: `HTTP ${response.status}${contentType ? ` (${contentType})` : ""}`,
      inactiveReason: null,
      httpStatus: response.status,
      contentType,
      userAgent: ua,
    };
  } catch (error) {
    return {
      ...item,
      protocol: protocolFor(item),
      live: false,
      error: error instanceof Error ? error.message : String(error),
      inactiveReason: null,
      httpStatus: null,
      contentType: null,
      userAgent: ua,
    };
  } finally {
    cancel();
  }
}

async function probe(item, budget, retryState) {
  const first = await probeOnce(item, UAS[0], budget);

  const needsFallback =
    first.httpStatus === 401 ||
    (first.httpStatus >= 300 && first.httpStatus < 400 && first.redirectUrl);

  if (!needsFallback || retryState.remaining <= 0) {
    return first;
  }

  retryState.remaining -= 1;
  retryState.used += 1;
  const fallbackUa =
    UAS[1 + (retryState.nextUa % Math.max(1, UAS.length - 1))];
  retryState.nextUa += 1;
  const retryTarget = first.redirectUrl || item.url;
  const second = await probeOnce(item, fallbackUa, budget, retryTarget);

  return {
    ...second,
    originalUrl: item.url,
    retried: true,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runner));
  return results;
}

function buildM3U(entries) {
  const lines = ["#EXTM3U", ""];
  for (const entry of entries) {
    lines.push(
      `#EXTINF:-1 group-title="${GROUP}",${entry.name}`,
      entry.url,
      ""
    );
  }
  return lines.join("\n");
}

function isSubrequestLimitError(error) {
  return /Too many subrequests by single Worker invocation|subrequest safety budget exhausted/i.test(
    error || ""
  );
}

async function getStored(env) {
  const [playlist, statusText] = await Promise.all([
    env.FPT_EVENT_KV.get(PLAYLIST_KEY),
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
    playlist: playlist || "#EXTM3U\n",
    status,
  };
}

async function recordFailure(env, error, meta = {}) {
  const previous = await getStored(env);
  const status = {
    ...(previous.status || {}),
    ok: false,
    scanHealthy: false,
    generatedAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
    ...meta,
  };

  if (cleanScan) {
    await env.FPT_EVENT_KV.put(
      HEALTHY_CHANNELS_KEY,
      JSON.stringify(live),
      { expirationTtl: PLAYLIST_TTL }
    );
  }

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: STATUS_TTL,
  });
  console.error(JSON.stringify(status));
}

async function scan(env, meta = {}) {
  const scanStarted = Date.now();
  const budget = { used: 0 };
  const retryState = { remaining: MAX_FALLBACK_PROBES, used: 0, nextUa: 0 };

  const previous = await getStored(env);
  const priorStatus = previous.status || {};
  const priorHealthyChannels =
    Array.isArray(priorStatus.lastHealthyLiveChannels) &&
    priorStatus.lastHealthyLiveChannels.length > 0
      ? priorStatus.lastHealthyLiveChannels
      : LAST_KNOWN_GOOD;

  const priorErrors = Array.isArray(priorStatus.errors) ? priorStatus.errors : [];
  const priorLooksBlocked =
    priorStatus.sourceBlocked === true ||
    (priorStatus.scanDegraded === true &&
      priorStatus.candidates > 0 &&
      priorStatus.probeErrors === priorStatus.candidates &&
      priorErrors.length > 0 &&
      priorErrors.every((x) => Number(x.httpStatus) === 403));

  if (priorLooksBlocked) {
    const recoveryStartIndex =
      Number.isInteger(priorStatus.recoveryProbeIndex)
        ? priorStatus.recoveryProbeIndex % priorHealthyChannels.length
        : 0;
    const recoveryCandidates = Array.from(
      { length: Math.min(RECOVERY_PROBE_LIMIT, priorHealthyChannels.length) },
      (_, offset) =>
        priorHealthyChannels[
          (recoveryStartIndex + offset) % priorHealthyChannels.length
        ]
    );

    const recoveryResults = await mapWithConcurrency(
      recoveryCandidates,
      1,
      (item) => probeOnce(item, UAS[0], budget)
    );

    const recoveryHealthy = recoveryResults.some(
      (item) => item.httpStatus === 200 && item.live
    );
    const recoverySaw403 = recoveryResults.some((item) => item.httpStatus === 403);
    const recoverySawReachable = recoveryResults.some(
      (item) =>
        item.httpStatus !== null &&
        item.httpStatus !== 403 &&
        item.httpStatus !== 401
    );
    const recoveryLooksBlocked = recoveryResults.length > 0 && !recoveryHealthy && !recoverySawReachable && recoverySaw403;

    let playlist = previous.playlist;
    let restoredFromFallback = false;
    if (playlist === "#EXTM3U\\n") {
      playlist = buildM3U(LAST_KNOWN_GOOD);
      restoredFromFallback = true;
      await env.FPT_EVENT_KV.put(PLAYLIST_KEY, playlist, {
        expirationTtl: PLAYLIST_TTL,
      });
    }

    const publishedAtText = await env.FPT_EVENT_KV.get(PUBLISHED_AT_KEY);
    const publishedAt = publishedAtText ? Number(publishedAtText) : 0;
    const status = {
      ...priorStatus,
      ok: true,
      scanHealthy: false,
      scanDegraded: true,
      recoveryMode: true,
      recoveryProbeSucceeded: recoveryHealthy,
      recoverySaw403,
      sourceBlocked: recoveryLooksBlocked,
      recoveryProbeIndex:
        (recoveryStartIndex + recoveryResults.length) % priorHealthyChannels.length,
      recoverySawReachable,
      stalePlaylist: true,
      staleExpired: false,
      restoredFromLastKnownGood: restoredFromFallback,
      workerVersion: WORKER_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - scanStarted,
      trigger: meta.trigger || "cron",
      cron: meta.cron || null,
      scheduledTime: meta.scheduledTime
        ? new Date(meta.scheduledTime).toISOString()
        : null,
      playlistEntries: playlist.match(/^#EXTINF:/gm)?.length || 0,
      publishedFromCurrentScan: false,
      lastHealthyLiveChannels:
        priorHealthyChannels.length > 0
          ? priorHealthyChannels
          : LAST_KNOWN_GOOD,
      subrequestBudget: {
        maxExternalSubrequests: MAX_EXTERNAL_SUBREQUESTS,
        used: budget.used,
        reservedMargin: 50 - MAX_EXTERNAL_SUBREQUESTS,
        primaryProbes: 0,
        recoveryProbeLimit: RECOVERY_PROBE_LIMIT,
        recoveryProbesUsed: recoveryResults.length,
        fallbackProbeLimit: MAX_FALLBACK_PROBES,
        fallbackProbesUsed: 0,
        concurrency: 1,
      },
    };

    if (recoveryHealthy) {
      status.sourceBlocked = false;
      status.message =
        "Recovery probe found a live FPT stream; full source scan will resume on the next 5-minute Cron.";
    } else if (recoverySawReachable) {
      status.sourceBlocked = false;
      status.message =
        "FPT source is reachable again but the sampled recovery streams are not live; full source scan will resume on the next 5-minute Cron.";
    } else {
      status.sourceBlocked = recoveryLooksBlocked;
      status.message =
        "FPT source still appears blocked; preserving the last healthy playlist and reducing probe frequency.";
    }

    await env.FPT_EVENT_KV.put(
      HEALTHY_CHANNELS_KEY,
      JSON.stringify(status.lastHealthyLiveChannels),
      { expirationTtl: PLAYLIST_TTL }
    );
    await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
      expirationTtl: STATUS_TTL,
    });
    console.log(JSON.stringify(status));
    return { playlist, status };
  }

  const sourceResponse = await fetchWithBudget(
    SOURCE_URL,
    {
      headers: {
        "User-Agent": UAS[0],
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
      cache: "no-store",
      redirect: "manual",
    },
    budget
  );

  if (!sourceResponse.ok) {
    throw new Error(`Source HTTP ${sourceResponse.status}`);
  }

  const sourceText = await sourceResponse.text();
  const candidates = parseSource(sourceText);

  if (!candidates.length) {
    throw new Error("Source M3U contains no valid entries");
  }

  // The source currently contains 46 endpoints. With the Free-plan safety budget,
  // a larger source must move to an explicit multi-invocation/batch architecture
  // instead of silently skipping endpoints.
  if (candidates.length > MAX_EXTERNAL_SUBREQUESTS - 1) {
    throw new Error(
      `Source contains ${candidates.length} endpoints; maximum safe full-scan size is ${MAX_EXTERNAL_SUBREQUESTS - 1}.`
    );
  }

  const results = await mapWithConcurrency(
    candidates,
    MAX_CONCURRENCY,
    (item) => probe(item, budget, retryState)
  );

  const live = results
    .filter((item) => item.live)
    .map(({ name, url }) => ({ name, url }));

  const probeErrors = results.filter((x) => x.error).length;
  const allProbeErrorsAreQuota =
    results.length > 0 &&
    results.every((x) => x.error && isSubrequestLimitError(x.error));

  const dashResults = results.filter((x) => x.protocol === "DASH");
  const hlsResults = results.filter((x) => x.protocol === "HLS");

  const previousHasPlaylist = previous.playlist !== "#EXTM3U\n";
  const publishedAtText = await env.FPT_EVENT_KV.get(PUBLISHED_AT_KEY);
  const publishedAt = publishedAtText ? Number(publishedAtText) : 0;
  const ageSinceHealthyPublish = publishedAt
    ? Date.now() - publishedAt
    : Number.POSITIVE_INFINITY;

  // Only a clean scan can change the published playlist. A degraded scan may contain
  // 403/timeouts/network failures, so it cannot safely decide that a live event ended.
  // Keep the last healthy snapshot for a short grace period; never keep stale data forever.
  const cleanScan = probeErrors === 0;
  const allProbeErrorsAre403 =
    results.length > 0 &&
    results.every((x) => x.error && Number(x.httpStatus) === 403);

  const preserveHealthySnapshot =
    !cleanScan &&
    previousHasPlaylist &&
    (allProbeErrorsAre403 ||
      ageSinceHealthyPublish <= DEGRADED_GRACE_MS);
  const staleExpired =
    !cleanScan &&
    previousHasPlaylist &&
    ageSinceHealthyPublish > DEGRADED_GRACE_MS;

  let playlist;
  if (cleanScan) {
    playlist = buildM3U(live);
    await env.FPT_EVENT_KV.put(PLAYLIST_KEY, playlist, {
      expirationTtl: PLAYLIST_TTL,
    });
    await env.FPT_EVENT_KV.put(PUBLISHED_AT_KEY, String(Date.now()), {
      expirationTtl: PLAYLIST_TTL,
    });
  } else if (preserveHealthySnapshot) {
    playlist = previous.playlist;
  } else {
    playlist = "#EXTM3U\n";
    await env.FPT_EVENT_KV.put(PLAYLIST_KEY, playlist, {
      expirationTtl: PLAYLIST_TTL,
    });
    await env.FPT_EVENT_KV.put(PUBLISHED_AT_KEY, String(Date.now()), {
      expirationTtl: PLAYLIST_TTL,
    });
  }

  const publishedPlaylistEntries =
    playlist.match(/^#EXTINF:/gm)?.length || 0;

  const status = {
    ok: true,
    scanHealthy: probeErrors === 0,
    scanDegraded: probeErrors > 0,
    stalePlaylist: preserveHealthySnapshot,
    staleExpired,
    lastHealthyPublishAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    degradedGraceMinutes: DEGRADED_GRACE_MS / 60000,
    workerVersion: WORKER_VERSION,
    generatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - scanStarted,
    trigger: meta.trigger || "manual",
    cron: meta.cron || null,
    scheduledTime: meta.scheduledTime
      ? new Date(meta.scheduledTime).toISOString()
      : null,
    sourceUrl: SOURCE_URL,
    recoveryMode: false,
    sourceBlocked: allProbeErrorsAre403,
    recoveryProbeSucceeded: false,
    recoverySaw403: false,
    candidates: candidates.length,
    liveEntries: live.length,
    playlistEntries: publishedPlaylistEntries,
    publishedFromCurrentScan: cleanScan,
    inactiveEntries: results.filter((x) => !x.live && !x.error).length,
    probeErrors,
    preservedBecauseDegradedScan: preserveHealthySnapshot,
    quotaFailureDetected: allProbeErrorsAreQuota,
    quotaSafetyBlocked: allProbeErrorsAreQuota,
    allProbeErrorsAre403,
    subrequestBudget: {
      maxExternalSubrequests: MAX_EXTERNAL_SUBREQUESTS,
      used: budget.used,
      reservedMargin: 50 - MAX_EXTERNAL_SUBREQUESTS,
      primaryProbes: candidates.length,
      fallbackProbeLimit: MAX_FALLBACK_PROBES,
      fallbackProbesUsed: retryState.used,
      concurrency: MAX_CONCURRENCY,
    },
    liveChannels: live,
    lastHealthyLiveChannels: cleanScan
      ? live
      : previous.status?.lastHealthyLiveChannels || LAST_KNOWN_GOOD,
    dashDiagnostics: dashResults.map((x) => ({
      name: x.name,
      url: x.url,
      live: x.live,
      error: x.error || null,
      inactiveReason: x.inactiveReason || null,
      httpStatus: x.httpStatus || null,
      contentType: x.contentType || null,
      userAgent: x.userAgent || null,
      retried: x.retried || false,
    })),
    protocolStats: {
      HLS: {
        candidates: hlsResults.length,
        live: hlsResults.filter((x) => x.live).length,
        inactive: hlsResults.filter((x) => !x.live && !x.error).length,
        errors: hlsResults.filter((x) => x.error).length,
      },
      DASH: {
        candidates: dashResults.length,
        live: dashResults.filter((x) => x.live).length,
        inactive: dashResults.filter((x) => !x.live && !x.error).length,
        errors: dashResults.filter((x) => x.error).length,
      },
    },
    errors: results
      .filter((x) => x.error)
      .slice(0, 12)
      .map((x) => ({
        name: x.name,
        url: x.url,
        protocol: x.protocol,
        httpStatus: x.httpStatus || null,
        error: x.error,
      })),
  };

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: STATUS_TTL,
  });

  console.log(JSON.stringify(status));
  return { playlist, status };
}

export default {
  async scheduled(controller, env) {
    try {
      await scan(env, {
        trigger: "cron",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      });
    } catch (error) {
      // Do not swallow the rejection: Cron Past Events must show the invocation
      // as failed when the scan really failed.
      await recordFailure(env, error, {
        trigger: "cron",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      });
      throw error;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/fpt-event-live.m3u") {
      const state = await getStored(env);
      const playlistEntries = state.playlist.match(/^#EXTINF:/gm)?.length || 0;
      return new Response(state.playlist, {
        headers: {
          "Content-Type": "application/x-mpegURL; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          "Access-Control-Allow-Origin": "*",
          "X-NM7-FPT-Events": String(playlistEntries),
          "X-NM7-FPT-Version": WORKER_VERSION,
        },
      });
    }

    if (url.pathname === "/status") {
      const state = await getStored(env);
      return Response.json({
        service: "NM7 FPT Event Live",
        scheduler: {
          cron: CRON,
          strategy: "full source scan every 5 minutes; quota-safe sequential pool",
        },
        ...(state.status || {
          ok: false,
          message: "Waiting for first scheduled scan",
        }),
      });
    }

    if (url.pathname === "/scan") {
      try {
        const state = await scan(env, { trigger: "manual" });
        return Response.json(state.status);
      } catch (error) {
        await recordFailure(env, error, { trigger: "manual" });
        return Response.json(
          {
            ok: false,
            scanHealthy: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 }
        );
      }
    }

    return new Response(
      "NM7 FPT Event Live\n\n/fpt-event-live.m3u\n/status\n/scan\n",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
