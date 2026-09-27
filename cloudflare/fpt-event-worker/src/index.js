const GROUP = "SỰ KIỆN FPT";
const SOURCE_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u";
const PLAYLIST_KEY = "fpt:live:playlist";
const STATUS_KEY = "fpt:live:status";
const CRON = "*/5 * * * *";
const PLAYLIST_TTL = 60 * 60;
const STATUS_TTL = 60 * 60;
const WORKER_VERSION = "fpt-event-resilient-v4-dash";

const UAS = ["VThanhTivi", "KhoaTivi", "BearTV"];

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

  return result;
}

function isLiveHls(text) {
  if (!text || !text.includes("#EXTM3U")) return false;
  if (text.includes("#EXT-X-ENDLIST")) return false;
  if (/^#EXT-X-PLAYLIST-TYPE:VOD\s*$/mi.test(text)) return false;

  const hasSegments = text.includes("#EXTINF:");
  const hasVariant = text.includes("#EXT-X-STREAM-INF:");
  const hasMediaSequence = text.includes("#EXT-X-MEDIA-SEQUENCE:");
  return hasSegments || hasVariant || hasMediaSequence;
}

function isLiveDash(text) {
  if (!text) return false;

  const xml = text.replace(/^\uFEFF/, "").trim();
  if (!/<MPD(?:\s|>)/i.test(xml)) return false;

  // DASH live streams normally use a dynamic MPD. Static MPDs are VOD/on-demand.
  const typeMatch = xml.match(/<MPD\b[^>]*\btype\s*=\s*["']([^"']+)["']/i);
  if (typeMatch && typeMatch[1].toLowerCase() !== "dynamic") return false;

  // If type is omitted, require a live-oriented MPD signal rather than accepting
  // arbitrary/static XML as a live stream.
  if (!typeMatch) {
    const hasLiveSignal =
      /\bminimumUpdatePeriod\s*=\s*["'][^"']+["']/i.test(xml) ||
      /\btimeShiftBufferDepth\s*=\s*["'][^"']+["']/i.test(xml) ||
      /\bavailabilityStartTime\s*=\s*["'][^"']+["']/i.test(xml);
    if (!hasLiveSignal) return false;
  }

  // A usable MPD must contain at least one AdaptationSet/Representation.
  return /<AdaptationSet\b/i.test(xml) && /<Representation\b/i.test(xml);
}

async function probe(item) {
  let lastError = null;

  for (const ua of UAS) {
    try {
      const response = await fetch(item.url, {
        method: "GET",
        headers: {
          "User-Agent": ua,
          "Accept":
            item.url.toLowerCase().includes(".mpd")
              ? "application/dash+xml,application/xml,text/xml,*/*"
              : "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
          "Cache-Control": "no-cache, no-store",
          "Pragma": "no-cache",
          "Referer": "https://fptplay.vn/",
          "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        cache: "no-store",
        redirect: "follow",
      });

      if (response.ok) {
        const body = await response.text();
        const isDash = /\.mpd(?:[?#]|$)/i.test(item.url);
        const live = isDash ? isLiveDash(body) : isLiveHls(body);
        return {
          ...item,
          protocol: isDash ? "DASH" : "HLS",
          live,
          error: null,
          userAgent: ua,
        };
      }

      if (response.status === 404) {
        return { ...item, live: false, error: null, inactiveReason: "HTTP 404" };
      }

      lastError = "HTTP " + response.status;
      if (response.status !== 401 && response.status !== 403) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ...item, live: false, error: lastError };
}

function buildM3U(entries) {
  const lines = ["#EXTM3U", ""];
  for (const entry of entries) {
    lines.push(
      "#EXTINF:-1 group-title=\"" + GROUP + "\"," + entry.name,
      entry.url,
      ""
    );
  }
  return lines.join("\n");
}

async function scan(env) {
  const sourceResponse = await fetch(SOURCE_URL + "?_=" + Date.now(), {
    headers: {
      "User-Agent": UAS[0],
      "Cache-Control": "no-cache, no-store",
      "Pragma": "no-cache",
    },
    cache: "no-store",
  });

  if (!sourceResponse.ok) {
    throw new Error("Source HTTP " + sourceResponse.status);
  }

  const sourceText = await sourceResponse.text();
  const candidates = parseSource(sourceText);

  if (!candidates.length) {
    throw new Error("Source M3U contains no valid entries");
  }

  const results = await Promise.all(candidates.map(probe));
  const live = results
    .filter((item) => item.live)
    .map(({ name, url }) => ({ name, url }));

  const probeErrors = results.filter((x) => x.error).length;
  const previous = await getStored(env);
  // Preserve the last good playlist if a partial probe failure could remove live channels.
  // An empty playlist is valid only after a clean scan of every source.
  const keepPrevious = probeErrors > 0 && previous.playlist !== "#EXTM3U\n";
  const playlist = keepPrevious ? previous.playlist : buildM3U(live);

  if (!keepPrevious) {
    await env.FPT_EVENT_KV.put(PLAYLIST_KEY, playlist, {
      expirationTtl: PLAYLIST_TTL,
    });
  }

  const status = {
    ok: true,
    workerVersion: WORKER_VERSION,
    generatedAt: new Date().toISOString(),
    candidates: candidates.length,
    liveEntries: live.length,
    inactiveEntries: results.filter((x) => !x.live && !x.error).length,
    probeErrors,
    stalePlaylist: keepPrevious,
    playlistEntries: keepPrevious ? (previous.playlist.match(/^#EXTINF:/gm) || []).length : live.length,
    liveChannels: live,
    liveProtocols: {
      HLS: live.filter((x) => !/\.mpd(?:[?#]|$)/i.test(x.url)).length,
      DASH: live.filter((x) => /\.mpd(?:[?#]|$)/i.test(x.url)).length,
    },
    errors: results
      .filter((x) => x.error)
      .slice(0, 12)
      .map((x) => ({ name: x.name, url: x.url, error: x.error })),
  };

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: STATUS_TTL,
  });

  console.log(JSON.stringify(status));
  return { playlist, status };
}

async function getStored(env) {
  const [playlist, statusText] = await Promise.all([
    env.FPT_EVENT_KV.get(PLAYLIST_KEY),
    env.FPT_EVENT_KV.get(STATUS_KEY),
  ]);

  return {
    playlist: playlist || "#EXTM3U\n",
    status: statusText ? JSON.parse(statusText) : null,
  };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      scan(env).catch(async (error) => {
        const status = {
          ok: false,
          generatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
          expirationTtl: STATUS_TTL,
        });
        console.error(JSON.stringify(status));
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/fpt-event-live.m3u") {
      const state = await getStored(env);
      return new Response(state.playlist, {
        headers: {
          "Content-Type": "application/x-mpegURL; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-NM7-FPT-Events":
            state.status && state.status.ok ? String(state.status.liveEntries) : "0",
        },
      });
    }

    if (url.pathname === "/status") {
      const state = await getStored(env);
      return Response.json({
        service: "NM7 FPT Event Live",
        scheduler: { cron: CRON, strategy: "full source scan every 5 minutes" },
        ...(state.status || {
          ok: false,
          message: "Waiting for first scheduled scan",
        }),
      });
    }

    if (url.pathname === "/scan") {
      try {
        const state = await scan(env);
        return Response.json(state.status);
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 }
        );
      }
    }

    return new Response(
      "NM7 FPT Event Live\n\n/fpt-event-live.m3u\n/status\n/scan\n",
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
