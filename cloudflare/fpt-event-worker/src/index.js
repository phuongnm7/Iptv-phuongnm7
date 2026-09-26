const GROUP = "SỰ KIỆN FPT";
const SOURCE_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u";
const PLAYLIST_KEY = "fpt:live:playlist";
const STATUS_KEY = "fpt:live:status";
const CRON = "*/5 * * * *";
const PLAYLIST_TTL = 7 * 60;

const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function parseSource(text) {
  const lines = text.split(/\r?\n/);
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF")) continue;

    const comma = line.indexOf(",");
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "Sự kiện FPT";

    // M3U may contain #EXTVLCOPT/#EXTHTTP and other metadata between
    // #EXTINF and the actual stream URL. Skip metadata until a URL is found.
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

async function probe(item) {
  try {
    const response = await fetch(item.url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept":
          "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "Referer": "https://fptplay.vn/",
        "Origin": "https://fptplay.vn/",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      cache: "no-store",
      redirect: "follow",
    });

    if (!response.ok) {
      return { ...item, live: false, error: "HTTP " + response.status };
    }

    const body = await response.text();
    return { ...item, live: isLiveHls(body), error: null };
  } catch (error) {
    return {
      ...item,
      live: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
      "User-Agent": UA,
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

  const playlist = buildM3U(live);

  await env.FPT_EVENT_KV.put(PLAYLIST_KEY, playlist, {
    expirationTtl: PLAYLIST_TTL,
  });

  const status = {
    ok: true,
    generatedAt: new Date().toISOString(),
    candidates: candidates.length,
    liveEntries: live.length,
    inactiveEntries: results.filter((x) => !x.live && !x.error).length,
    probeErrors: results.filter((x) => x.error).length,
    errors: results
      .filter((x) => x.error)
      .slice(0, 12)
      .map((x) => ({ name: x.name, url: x.url, error: x.error })),
  };

  await env.FPT_EVENT_KV.put(STATUS_KEY, JSON.stringify(status), {
    expirationTtl: PLAYLIST_TTL,
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
          expirationTtl: PLAYLIST_TTL,
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
