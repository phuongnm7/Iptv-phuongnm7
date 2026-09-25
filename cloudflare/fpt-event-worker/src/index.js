
const GROUP = "SỰ KIỆN FPT";
const BATCH_SIZE = 50;
const BATCH_COUNT = 5;
const BATCH_KEYS = Array.from({ length: BATCH_COUNT }, (_, i) => "fpt:batch:" + i);

const VIPS = "https://vips-livecdn.fptplay.net/live/media";
const LIVECDN = "https://livecdn.fptplay.net/schedule";

const CANDIDATES = [];
function add(name, url, source) {
  CANDIDATES.push({ name, url, source });
}

for (let i = 1; i <= 50; i++) {
  const n = String(i).padStart(2, "0");
  add("Sự kiện FPT " + n, VIPS + "/su-kien-" + n + "/hls_avc_v6/index.m3u8", "VIPS");
  add("Sự kiện FPT " + n, LIVECDN + "/sukien" + n + "_vhls.smil/chunklist_b5000000.m3u8", "LIVECDN");
  add("Sự kiện FPT " + n + " 4K", VIPS + "/su-kien-" + n + "-4k/hls_avc_v6/index.m3u8", "VIPS");
  add("Sự kiện FPT Event " + n, VIPS + "/event-" + n + "/hls_avc_v6/index.m3u8", "VIPS");
  add("Sự kiện FPT Event " + n + " 4K", VIPS + "/event-" + n + "-4k/hls_avc_v6/index.m3u8", "VIPS");
}

const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function parseBatchId(value) {
  const batchId = Number(value);
  return Number.isInteger(batchId) && batchId >= 0 && batchId < BATCH_COUNT
    ? batchId
    : null;
}

function cacheBust(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("_nm7_probe", String(Date.now()));
  return url.toString();
}

function canonicalPlayerUrl(rawUrl) {
  const marker = "/hls_avc_v6/";
  if (!rawUrl.includes(marker)) return rawUrl;
  return rawUrl.split(marker)[0] + marker + "index.m3u8";
}

function isPlaylist(text) {
  return (
    text.includes("#EXTINF:") ||
    text.includes("#EXT-X-STREAM-INF:")
  );
}

function classifyPlaylist(text) {
  if (!text || !text.includes("#EXTM3U")) return "inactive";
  if (text.includes("#EXT-X-ENDLIST")) return "inactive";
  if (!isPlaylist(text)) return "inactive";
  return "live";
}

async function probe(candidate) {
  const playerUrl = canonicalPlayerUrl(candidate.url);

  try {
    const headers = {
      "User-Agent": UA,
      "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
      "Cache-Control": "no-cache, no-store",
      "Pragma": "no-cache",
      "Referer": "https://fptplay.vn/",
      "Origin": "https://fptplay.vn/",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    };

    // Some FPT CDN paths can reject/cache-bust query strings even though the
    // exact public URL is playable. Try the exact URL first, then a cache-busted
    // retry. This prevents a false inactive/error result for a genuinely live event.
    const urls = [playerUrl, cacheBust(playerUrl)];
    let response = null;
    let text = "";
    let lastError = null;

    for (const requestUrl of urls) {
      try {
        const current = await fetch(requestUrl, {
          method: "GET",
          headers,
          redirect: "follow",
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        response = current;
        if (current.ok) {
          text = await current.text();
          if (classifyPlaylist(text) === "live") break;
        } else {
          lastError = "HTTP " + current.status;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (response && response.ok && classifyPlaylist(text) === "live") {
      return { ...candidate, status: "live", url: playerUrl };
    }

    if (response && (response.status === 404 || response.status === 410)) {
      return { ...candidate, status: "inactive", url: playerUrl };
    }

    if (response && !response.ok) {
      return {
        ...candidate,
        status: "error",
        url: playerUrl,
        error: lastError || "HTTP " + response.status,
      };
    }

    if (response && response.ok) {
      return { ...candidate, status: "inactive", url: playerUrl };
    }

    return {
      ...candidate,
      status: "error",
      url: playerUrl,
      error: lastError || "No response",
    };

    const status = classifyPlaylist(text);

    if (status === "live") {
      return { ...candidate, status: "live", url: playerUrl };
    }

    return { ...candidate, status: "inactive", url: playerUrl };
  } catch (error) {
    return {
      ...candidate,
      status: "error",
      url: playerUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function scanBatch(batchId) {
  const start = batchId * BATCH_SIZE;
  const candidates = CANDIDATES.slice(start, start + BATCH_SIZE);
  const results = await Promise.all(candidates.map(probe));

  // STRICT MODE: publish ONLY confirmed live entries.
  // HTTP/network errors are diagnostic only and must NEVER enter the playlist/KV entries.
  const entries = results
    .filter((item) => item.status === "live")
    .map((item) => ({
      name: item.name,
      url: item.url,
      source: item.source,
      status: item.status,
    }));

  return {
    batch: batchId,
    scanned: candidates.length,
    liveCount: results.filter((item) => item.status === "live").length,
    errorCount: results.filter((item) => item.status === "error").length,
    inactiveCount: results.filter((item) => item.status === "inactive").length,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

function chooseEntries(batchResults) {
  const byName = new Map();

  for (const batch of batchResults) {
    if (!batch || !Array.isArray(batch.entries)) continue;

    for (const item of batch.entries) {
      const current = byName.get(item.name);
      if (!current) {
        byName.set(item.name, item);
        continue;
      }

      if (current.status === "error" && item.status === "live") {
        byName.set(item.name, item);
        continue;
      }

      // Prefer the VIPS master URL. The LIVECDN child rendition can be
      // video-only and may reproduce the historical "picture without audio"
      // problem. Keep VIPS when both sources report the same event as live.
      if (
        current.status === "live" &&
        item.status === "live" &&
        current.source === "LIVECDN" &&
        item.source === "VIPS"
      ) {
        byName.set(item.name, item);
      }
    }
  }

  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "vi"))
    .map((item) => ({
      name: item.name,
      url: item.url,
      status: item.status,
      source: item.source,
    }));
}

function buildM3U(entries) {
  const lines = ["#EXTM3U", ""];

  for (const entry of entries) {
    lines.push(
      '#EXTINF:-1 group-title="' + GROUP + '",' + entry.name,
      entry.url,
      ""
    );
  }

  return lines.join("\n");
}

async function readAllBatches(env) {
  const values = await Promise.all(
    BATCH_KEYS.map((key) =>
      env.FPT_EVENT_KV.get(key, { type: "json", cacheTtl: 30 })
    )
  );

  return values.map((value) => value || null);
}

async function buildPlaylist(env) {
  const batches = await readAllBatches(env);
  const ready = batches.filter(Boolean).length;
  const entries = chooseEntries(batches);

  return {
    ready,
    entries,
    m3u: buildM3U(entries),
    batches,
  };
}

async function runBatch(batchId, env) {
  const result = await scanBatch(batchId);

  await env.FPT_EVENT_KV.put(
    BATCH_KEYS[batchId],
    JSON.stringify(result)
  );

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/scan") {
      const batchId = parseBatchId(url.searchParams.get("batch"));

      if (batchId === null) {
        return Response.json(
          { ok: false, error: "batch must be 0, 1, 2, 3 or 4" },
          { status: 400 }
        );
      }

      const result = await runBatch(batchId, env);

      return Response.json({
        ok: true,
        batch: result.batch,
        scanned: result.scanned,
        live: result.liveCount,
        inactive: result.inactiveCount,
        errors: result.errorCount,
        generatedAt: result.generatedAt,
      });
    }

    if (url.pathname === "/fpt-event-live.m3u") {
      const state = await buildPlaylist(env);

      if (state.ready < BATCH_COUNT) {
        return new Response("#EXTM3U\n", {
          status: 503,
          headers: {
            "Content-Type": "application/x-mpegURL; charset=utf-8",
            "Cache-Control": "no-store",
            "X-NM7-Scanner-State": state.ready + "/" + BATCH_COUNT,
          },
        });
      }

      return new Response(state.m3u, {
        headers: {
          "Content-Type": "application/x-mpegURL; charset=utf-8",
          "Cache-Control": "public, max-age=30",
          "Access-Control-Allow-Origin": "*",
          "X-NM7-FPT-Events": String(state.entries.length),
        },
      });
    }

    if (url.pathname === "/status") {
      const state = await buildPlaylist(env);

      return Response.json({
        service: "NM7 FPT Event Live",
        ready: state.ready === BATCH_COUNT,
        batchesReady: state.ready,
        batchCount: BATCH_COUNT,
        candidates: CANDIDATES.length,
        liveEntries: state.entries.filter((x) => x.status === "live").length,
        staleEntries: state.entries.filter((x) => x.status === "error").length,
        generatedAt: state.batches
          .filter(Boolean)
          .map((x) => x.generatedAt)
          .sort()
          .at(-1) || null,
        entries: state.entries,
      });
    }

    return new Response(
      "NM7 FPT Event Live Worker\n\n/fpt-event-live.m3u\n/status\n/scan?batch=0..4\n",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
