import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAIN_MODULE_URL =
  "https://raw.githubusercontent.com/phuongnm7/nm7-tv-web/main/api/vietmitv-source.js";
const FALLBACK_MODULE_URL =
  "https://raw.githubusercontent.com/phuongnm7/nm7-tv-web/main/api/vietmitv-sports-fallback.js";
// Deliberately preserve the original sports playlist URL byte-for-byte.
const SPORTS_URL =
  "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sports-auto.m3u?utm_source=chatgpt.com";
const TARGET_GROUPS = [
  "Giờ Vàng TV",
  "Gà Vàng 24h TV",
  "Gà Vàng 33 TV",
  "S8 TV",
  "Sao Kê TV",
];

function validatePlaylist(input, label) {
  const value = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*#EXTM3U\b/im.test(value) || !/^\s*#EXTINF:/im.test(value)) {
    throw new Error(label + " không phải M3U hợp lệ");
  }
  return value;
}

async function fetchText(url, label, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/x-mpegURL, audio/x-mpegurl, text/plain, */*",
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "User-Agent": "NM7-VietMiTV-GitHub-Generator/1",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(label + " HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeGroup(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
}

function extractEntries(m3u) {
  const entries = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const hasUrl = current.some((line) => {
      const value = line.trim();
      return value && !value.startsWith("#") &&
        /^(https?|rtsp|rtmp|udp):\/\//i.test(value.split("|")[0]);
    });
    if (hasUrl) entries.push(current);
  };
  for (const line of m3u.split(/\r?\n/)) {
    if (/^\s*#EXTM3U\b/i.test(line)) continue;
    if (/^\s*#EXTINF:/i.test(line)) {
      finish();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  finish();
  return entries;
}

function entryGroup(entry) {
  const extinf = entry.find((line) => /^\s*#EXTINF:/i.test(line)) || "";
  const match = /\bgroup-title\s*=\s*["']([^"']*)["']/i.exec(extinf);
  if (match) return match[1].trim();
  const extgrp = entry.find((line) => /^\s*#EXTGRP:/i.test(line)) || "";
  return extgrp.replace(/^\s*#EXTGRP:/i, "").trim();
}

function composePlaylist(mainM3u, sportsM3u, fallbackM3u) {
  const mainLines = mainM3u.split(/\r?\n/);
  const header = mainLines.find((line) => /^\s*#EXTM3U\b/i.test(line)) || "#EXTM3U";
  const mainBody = mainLines.filter((line) => !/^\s*#EXTM3U\b/i.test(line)).join("\n").trim();
  if (!mainBody) throw new Error("M3U chính không có nội dung kênh");

  const targets = new Set(TARGET_GROUPS.map(normalizeGroup));
  const liveExtras = extractEntries(sportsM3u).filter((entry) => targets.has(normalizeGroup(entryGroup(entry))));
  const liveGroups = new Set(liveExtras.map((entry) => normalizeGroup(entryGroup(entry))));
  const missingGroups = new Set([...targets].filter((group) => !liveGroups.has(group)));
  const fallbackExtras = extractEntries(fallbackM3u).filter((entry) =>
    targets.has(normalizeGroup(entryGroup(entry))) && missingGroups.has(normalizeGroup(entryGroup(entry)))
  );
  const extras = liveExtras.concat(fallbackExtras);
  const availableGroups = new Set(extras.map((entry) => normalizeGroup(entryGroup(entry))));
  const missing = [...targets].filter((group) => !availableGroups.has(group));
  if (missing.length) throw new Error("Thiếu nhóm thể thao cả ở nguồn chính lẫn dự phòng: " + missing.join(", "));

  const merged = header + "\n" + mainBody + "\n" +
    extras.map((entry) => entry.join("\n").trim()).join("\n") + "\n";
  const mainEntries = extractEntries(mainM3u);
  const mainGroups = [...new Set(mainEntries.map((entry) => entryGroup(entry)).filter(Boolean))];
  const extraGroups = [...new Set(extras.map((entry) => entryGroup(entry)))];
  return {
    m3u: merged,
    mainEntries: mainEntries.length,
    mainGroups,
    extraEntries: extras.length,
    extraGroups,
    totalEntries: extractEntries(merged).length,
  };
}

const tempDir = await mkdtemp(path.join(tmpdir(), "nm7-vietmitv-"));
try {
  const [mainModuleText, fallbackModuleText] = await Promise.all([
    fetchText(MAIN_MODULE_URL, "Mã nguồn M3U chính"),
    fetchText(FALLBACK_MODULE_URL, "Mã nguồn M3U dự phòng"),
  ]);
  const mainPath = path.join(tempDir, "vietmitv-source.mjs");
  const fallbackPath = path.join(tempDir, "vietmitv-fallback.mjs");
  await Promise.all([
    writeFile(mainPath, mainModuleText, "utf8"),
    writeFile(fallbackPath, fallbackModuleText, "utf8"),
  ]);

  // Execute the existing integrity-checked Node source module in Actions rather than
  // reimplementing or altering its compressed-data format.
  const sourceModule = await import(pathToFileURL(mainPath).href + "?v=" + Date.now());
  const fallbackModule = await import(pathToFileURL(fallbackPath).href + "?v=" + Date.now());
  const mainM3u = validatePlaylist(sourceModule.getVietMiTVPlaylist(), "M3U chính đã đóng gói");
  const fallbackM3u = validatePlaylist(fallbackModule.getSportsFallbackM3U(), "M3U thể thao dự phòng");

  let sportsM3u = fallbackM3u;
  let sportsSource = "bundled-fallback";
  try {
    sportsM3u = validatePlaylist(await fetchText(SPORTS_URL, "sports-auto.m3u"), "sports-auto.m3u");
    sportsSource = "live";
  } catch (error) {
    console.warn("Nguồn thể thao trực tiếp lỗi; dùng dữ liệu dự phòng:", error instanceof Error ? error.message : String(error));
  }

  const result = composePlaylist(mainM3u, sportsM3u, fallbackM3u);
  const outputPath = path.resolve("generated/vietmitv-merge.m3u");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.m3u, "utf8");

  console.log(JSON.stringify({
    output: outputPath,
    sportsSource,
    mainChannels: result.mainEntries,
    mainGroups: result.mainGroups.length,
    extraChannels: result.extraEntries,
    extraGroups: result.extraGroups,
    totalChannels: result.totalEntries,
    bytes: Buffer.byteLength(result.m3u, "utf8"),
    sha256: (await import("node:crypto")).createHash("sha256").update(result.m3u).digest("hex"),
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
