const APP_URL = "https://freem3u.xyz/api/channels/x_1.0.1/app.json";

const APP_HEADERS = {
  "User-Agent": "okhttp/4.12.0",
  "Accept": "application/json,text/plain,*/*",
  "Cache-Control": "no-cache"
};

const PLAYLIST_HEADERS = {
  "Content-Type": "application/x-mpegURL; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "X-NM7-VAppTV-Mode": "dynamic-per-channel"
};

const UA_FALLBACK = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135.0 Mobile Safari/537.36";

function cleanText(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function attr(value) {
  return cleanText(value).replace(/"/g, "'");
}

function isHttp(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function looksStream(value) {
  if (!isHttp(value)) return false;
  const u = value.toLowerCase();
  return /\.(m3u8|mpd)(\?|$)/i.test(u)
    || u.includes("/api/live/play.m3u8")
    || u.includes("/manifest")
    || u.includes("/playlist")
    || u.includes("/chunklist")
    || u.includes(".smil/")
    || u.includes("/hls/");
}

function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(text) {
  const s = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const binary = atob(s + pad);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extractJsonPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  const parts = String(path).match(/[^.\[\]]+/g) || [];
  for (const part of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && part in cur) {
      cur = cur[part];
    } else if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return null;
      cur = cur[i];
    } else {
      return null;
    }
  }
  return cur;
}

function collectHttpUrls(value, out = []) {
  if (typeof value === "string") {
    if (isHttp(value)) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectHttpUrls(item, out);
  }
  return out;
}

function parseShaka(url) {
  try {
    const u = new URL(url);
    const videoUrl = u.searchParams.get("videoUrl");
    const audioUrl = u.searchParams.get("audioUrl");
    const keys = u.searchParams.get("keys");
    if (isHttp(videoUrl) && looksStream(videoUrl)) {
      return { url: videoUrl, clearkey: keys || null };
    }
    if (isHttp(audioUrl) && looksStream(audioUrl)) {
      return { url: audioUrl, clearkey: null };
    }
  } catch {}
  return null;
}

function sourceHeaders(spec) {
  const h = new Headers();
  const merged = {};
  if (spec?.headers && typeof spec.headers === "object") Object.assign(merged, spec.headers);
  if (spec?.httpConfig?.headers && typeof spec.httpConfig.headers === "object") Object.assign(merged, spec.httpConfig.headers);
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null && String(v).trim()) h.set(String(k), String(v));
  }
  if (!h.has("User-Agent")) h.set("User-Agent", UA_FALLBACK);
  return h;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...init
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + url);
  return response.json();
}

async function resolveProviderSpec(spec, depth = 0) {
  if (!spec || typeof spec !== "object" || !isHttp(spec.url) || depth > 3) return null;

  const url = String(spec.url).trim();
  const headers = sourceHeaders(spec);
  const provider = spec.provider || "";

  if (!provider) {
    const shaka = parseShaka(url);
    if (shaka) return { ...shaka, headers };
    if (looksStream(url)) return { url, clearkey: null, headers };
    return null;
  }

  if (provider === "webview") {
    const shaka = parseShaka(url);
    if (shaka) return { ...shaka, headers };
    if (looksStream(url)) return { url, clearkey: null, headers };
    return null;
  }

  try {
    if (provider === "flow") {
      const r = await fetch(url, { headers, redirect: "follow" });
      if (!r.ok) return null;
      const text = await r.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }

      // freem3u flow/play.json may return:
      // { data: { url, provider, jsonPath, httpConfig, ... } }
      const data = payload && typeof payload === "object" && "data" in payload
        ? payload.data
        : payload;

      if (data && typeof data === "object" && data.provider && data.url) {
        return await resolveProviderSpec(data, depth + 1);
      }

      const urls = collectHttpUrls(data);
      for (const u of urls) {
        if (looksStream(u)) return { url: u, clearkey: null, headers };
      }
      return null;
    }

    if (provider === "json") {
      const cfg = spec.httpConfig && typeof spec.httpConfig === "object" ? spec.httpConfig : {};
      const method = String(cfg.method || "GET").toUpperCase();
      const h = new Headers(headers);
      if (cfg.headers && typeof cfg.headers === "object") {
        for (const [k, v] of Object.entries(cfg.headers)) {
          if (v !== undefined && v !== null) h.set(String(k), String(v));
        }
      }

      let body;
      if (method !== "GET" && method !== "HEAD" && cfg.body != null) {
        body = String(cfg.body);
      }

      const r = await fetch(url, { method, headers: h, body, redirect: "follow" });
      if (!r.ok) return null;

      const payload = await r.json();
      const value = extractJsonPath(payload, spec.jsonPath);
      const urls = collectHttpUrls(value);

      for (const u of urls) {
        if (looksStream(u)) return { url: u, clearkey: null, headers: h };
      }
      return null;
    }

    if (provider === "parser") {
      const r = await fetch(url, { headers, redirect: "follow" });
      if (!r.ok) return null;

      const text = await r.text();
      const start = String(spec.startWith || "");
      const end = String(spec.endWith || "");
      let pos = 0;
      const count = Math.max(1, Number(spec.startWithIndex || 1));

      for (let i = 0; i < count; i++) {
        pos = text.indexOf(start, pos);
        if (pos < 0) return null;
        pos += start.length;
      }

      const endPos = end ? text.indexOf(end, pos) : -1;
      const value = text.slice(pos, endPos >= 0 ? endPos : undefined).trim();
      if (isHttp(value)) {
        if (looksStream(value)) return { url: value, clearkey: null, headers };
        return null;
      }

      const urls = collectHttpUrls(value);
      for (const u of urls) {
        if (looksStream(u)) return { url: u, clearkey: null, headers };
      }
      return null;
    }
  } catch {}

  return null;
}

async function loadApp() {
  const r = await fetch(APP_URL, {
    headers: APP_HEADERS,
    cache: "no-store"
  });
  if (!r.ok) throw new Error("vAppTV API HTTP " + r.status);
  return r.json();
}

function groupOrder(app) {
  const ordered = [];
  const seen = new Set();

  for (const item of (app.group || [])) {
    const g = cleanText(item?.title);
    if (g && !seen.has(g)) {
      seen.add(g);
      ordered.push(g);
    }
  }

  // Preserve group tags found on channels even when they are absent
  // from the top-level group config.
  for (const channel of (app.channels || [])) {
    for (const raw of (channel.group || [])) {
      const g = cleanText(raw);
      if (g && !seen.has(g)) {
        seen.add(g);
        ordered.push(g);
      }
    }
  }

  return ordered;
}

function channelById(app, id) {
  const needle = cleanText(id);
  return (app.channels || []).find(c => cleanText(c.id) === needle) || null;
}

async function selectBestSource(channel) {
  const specs = Array.isArray(channel?.urls) ? channel.urls : [];

  // Same preference model as vAppTV, but with dynamic resolution:
  // direct stream first, then webview/shaka, then flow/json/parser.
  const priority = specs.map((spec, index) => {
    let p = 50 + index;
    if (!spec?.provider && looksStream(spec?.url)) p = 0;
    else if (spec?.provider === "webview") p = 10;
    else if (spec?.provider === "flow") p = 20;
    else if (spec?.provider === "json") p = 30;
    else if (spec?.provider === "parser") p = 40;
    return { spec, index, p };
  }).sort((a, b) => a.p - b.p);

  for (const item of priority) {
    const resolved = await resolveProviderSpec(item.spec);
    if (resolved?.url) return resolved;
  }

  return null;
}

function m3uHeader(epgList) {
  const epg = (epgList || []).filter(isHttp).join(",");
  return epg ? '#EXTM3U x-tvg-url="' + attr(epg) + '"' : "#EXTM3U";
}

function makeStreamUrl(base, channelId) {
  return base + "/stream?id=" + encodeURIComponent(channelId);
}

async function buildPlaylist(request) {
  const app = await loadApp();
  const groups = groupOrder(app);
  const byGroup = new Map(groups.map(g => [g, []]));

  for (const channel of (app.channels || []).slice().sort((a, b) => {
    const ai = Number.isFinite(Number(a.channelIndex)) ? Number(a.channelIndex) : 999999;
    const bi = Number.isFinite(Number(b.channelIndex)) ? Number(b.channelIndex) : 999999;
    return ai - bi;
  })) {
    const memberships = (channel.group || []).map(cleanText).filter(Boolean);
    const finalGroups = memberships.length ? memberships : ["vAppTV"];

    const entry = {
      id: cleanText(channel.id),
      title: cleanText(channel.title || channel.id),
      tvgId: cleanText(channel.tvgId || channel.id),
      logo: cleanText(channel.thumbnail || channel.logo || ""),
      index: Number.isFinite(Number(channel.channelIndex)) ? Number(channel.channelIndex) : "",
      groups: finalGroups
    };

    for (const g of finalGroups) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(entry);
    }
  }

  const base = new URL(request.url).origin;
  const out = [m3uHeader(app.epgList)];

  for (const group of [...groups, ...[...byGroup.keys()].filter(g => !groups.includes(g))]) {
    for (const entry of byGroup.get(group) || []) {
      let line = "#EXTINF:-1";
      if (entry.tvgId) line += ' tvg-id="' + attr(entry.tvgId) + '"';
      if (entry.title) line += ' tvg-name="' + attr(entry.title) + '"';
      if (entry.index !== "") line += ' tvg-chno="' + attr(entry.index) + '"';
      if (entry.logo) line += ' tvg-logo="' + attr(entry.logo) + '"';
      line += ' group-title="' + attr(group) + '",' + entry.title;

      out.push(line);
      out.push("#X-NM7-VAPPTV-DYNAMIC:1");
      out.push("#X-APP-CHANNEL-ID:" + entry.id);
      if (entry.index !== "") out.push("#X-APP-CHANNEL-INDEX:" + entry.index);

      // One stable URL per channel. The Worker resolves the current source
      // every time the player opens it, so channel changes upstream propagate
      // without rebuilding the M3U file.
      out.push(makeStreamUrl(base, entry.id));

      // For the important DRM case, fetch the current key once per request
      // only for a channel when ?resolve=1 is explicitly requested. The
      // default playlist stays at one API subrequest.
    }
  }

  return new Response(out.join("\n") + "\n", { status: 200, headers: PLAYLIST_HEADERS });
}

async function streamResponse(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  const app = await loadApp();
  const channel = channelById(app, id);
  if (!channel) return new Response("Channel not found", { status: 404 });

  const resolved = await selectBestSource(channel);
  if (!resolved?.url) {
    return new Response("No currently resolvable source for " + id, {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // Native redirect for normal streams. This keeps the media bandwidth
  // off the Worker and makes the URL dynamic per playback request.
  const h = resolved.headers instanceof Headers ? resolved.headers : sourceHeaders({});
  const needsHeaderProxy = h.size > 0;

  if (!needsHeaderProxy) {
    return Response.redirect(resolved.url, 302);
  }

  // Fetch the manifest through the Worker so provider-required headers
  // can still be applied. For HLS, rewrite relative segment/KEY URLs
  // back through this Worker.
  const upstream = await fetch(resolved.url, {
    headers: h,
    redirect: "follow"
  });

  if (!upstream.ok) {
    return new Response("Upstream HTTP " + upstream.status, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isHls = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(resolved.url);

  if (!isHls) {
    const headers = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())) {
        headers.set(k, v);
      }
    }
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const text = await upstream.text();
  const workerOrigin = new URL(request.url).origin;
  const proxyHeaderToken = base64urlEncode(JSON.stringify(Object.fromEntries(h.entries())));

  const lines = text.split(/\r?\n/);
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
        try {
          const abs = new URL(uri, resolved.url).href;
          return 'URI="' + workerOrigin + "/proxy?u=" + encodeURIComponent(abs) + "&h=" + encodeURIComponent(proxyHeaderToken) + '"';
        } catch {
          return 'URI="' + uri + '"';
        }
      });
    }

    try {
      const abs = new URL(trimmed, resolved.url).href;
      return workerOrigin + "/proxy?u=" + encodeURIComponent(abs) + "&h=" + encodeURIComponent(proxyHeaderToken);
    } catch {
      return line;
    }
  }).join("\n");

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function proxyResponse(request) {
  const u = new URL(request.url);
  const target = u.searchParams.get("u");
  const token = u.searchParams.get("h");
  if (!isHttp(target)) return new Response("Invalid proxy target", { status: 400 });

  let headers = new Headers();
  if (token) {
    try {
      const obj = JSON.parse(base64urlDecode(token));
      headers = new Headers(obj);
    } catch {}
  }

  const upstream = await fetch(target, {
    headers,
    redirect: "follow"
  });

  if (!upstream.ok) {
    return new Response("Upstream HTTP " + upstream.status, {
      status: upstream.status,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isHls = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target);

  if (!isHls) {
    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())) {
        outHeaders.set(k, v);
      }
    }
    outHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  const text = await upstream.text();
  const origin = new URL(request.url).origin;
  const headerToken = token || base64urlEncode(JSON.stringify(Object.fromEntries(headers.entries())));
  const rewritten = text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
        try {
          const abs = new URL(uri, target).href;
          return 'URI="' + origin + "/proxy?u=" + encodeURIComponent(abs) + "&h=" + encodeURIComponent(headerToken) + '"';
        } catch {
          return 'URI="' + uri + '"';
        }
      });
    }

    try {
      const abs = new URL(trimmed, target).href;
      return origin + "/proxy?u=" + encodeURIComponent(abs) + "&h=" + encodeURIComponent(headerToken);
    } catch {
      return line;
    }
  }).join("\n");

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/playlist.m3u" || url.pathname === "/") {
        return await buildPlaylist(request);
      }

      if (url.pathname === "/stream") {
        return await streamResponse(request, env);
      }

      if (url.pathname === "/proxy") {
        return await proxyResponse(request);
      }

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({
          ok: true,
          mode: "dynamic-per-channel",
          source: APP_URL,
          updatedAt: new Date().toISOString()
        }, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return new Response(String(error?.message || error), {
        status: 502,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
