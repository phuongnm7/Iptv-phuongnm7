#!/usr/bin/env python3
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SOURCE_URL = "https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u"
EVENT7_URL = "https://vips-livecdn.fptplay.net/live/media/event-07/hls_avc_v6/index.m3u8"
HPROXY_URL = (
    "https://hproxy.com/api/proxy-list"
    "?format=json&country=VN&protocol=http&recent=true&sort=uptime&limit=100"
)
OUTPUT_M3U = os.environ.get("OUTPUT_M3U", "generated/fpt-event-live.m3u")
OUTPUT_STATUS = os.environ.get("OUTPUT_STATUS", "generated/fpt-event-live.status.json")
MAX_PROXY_TRIES = int(os.environ.get("MAX_PROXY_TRIES", "40"))
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "15"))

HEADERS = [
    ("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"),
    ("Referer", "https://fptplay.vn/"),
    ("Origin", "https://fptplay.vn"),
    ("Accept", "application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,text/plain,*/*"),
    ("Cache-Control", "no-cache, no-store"),
    ("Pragma", "no-cache"),
]

def get_text(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": HEADERS[0][1],
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

def parse_source(text):
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        line = line.strip()
        if not line.startswith("#EXTINF"):
            continue
        name = line.split(",", 1)[1].strip() if "," in line else "Sự kiện FPT"
        url = ""
        for j in range(i + 1, min(i + 8, len(lines))):
            candidate = lines[j].strip()
            if not candidate or candidate.startswith("#"):
                continue
            if candidate.startswith(("http://", "https://")):
                url = candidate
                break
        if url:
            out.append({"name": name, "url": url})
    seen = set()
    unique = []
    for item in out:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        unique.append(item)
    return unique

def is_live_hls(body):
    upper = body.upper()
    if "#EXTM3U" not in upper:
        return False
    if "#EXT-X-ENDLIST" in upper:
        return False
    if "#EXT-X-PLAYLIST-TYPE:VOD" in upper:
        return False
    return (
        "#EXTINF:" in upper
        or "#EXT-X-STREAM-INF:" in upper
        or "#EXT-X-MEDIA-SEQUENCE:" in upper
    )

def is_live_dash(body):
    upper = body.upper()
    if "<MPD" not in upper:
        return False
    if 'TYPE="STATIC"' in upper or "TYPE='STATIC'" in upper:
        return False
    live_signal = any(
        token in upper
        for token in (
            "TYPE="DYNAMIC"",
            "TYPE='DYNAMIC'",
            "MINIMUMUPDATEPERIOD=",
            "TIMESHIFTBUFFERDEPTH=",
            "AVAILABILITYSTARTTIME=",
            "SUGGESTEDPRESENTATIONDELAY=",
        )
    )
    media_signal = any(
        token in upper
        for token in (
            "<ADAPTATIONSET",
            "<REPRESENTATION",
            "<SEGMENTTEMPLATE",
            "<SEGMENTTIMELINE",
        )
    )
    return live_signal and media_signal

def curl_probe(url, proxy=None):
    cmd = [
        "curl", "-sS", "--http1.1", "--max-time", str(PROBE_TIMEOUT),
        "-o", "-", "-D", "-", "-w", "\n__NM7_STATUS__:%{http_code}|%{content_type}|%{size_download}\n",
    ]
    if proxy:
        cmd += ["-x", f"http://{proxy}"]
    for key, value in HEADERS:
        cmd += ["-H", f"{key}: {value}"]
    cmd += [url]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=PROBE_TIMEOUT + 5)
    except Exception as exc:
        return {"url": url, "status": 0, "content_type": "", "body": "", "error": str(exc)}
    raw = p.stdout
    marker = "\n__NM7_STATUS__:"
    idx = raw.rfind(marker)
    body_and_headers = raw[:idx] if idx >= 0 else raw
    status_line = raw[idx + len(marker):].strip() if idx >= 0 else "0||0"
    parts = status_line.split("|", 2)
    status = int(parts[0]) if parts and parts[0].isdigit() else 0
    content_type = parts[1] if len(parts) > 1 else ""
    # Split response headers from body. curl's -D - can include multiple blocks.
    body = body_and_headers.split("\r\n\r\n")[-1].split("\n\n")[-1]
    return {
        "url": url,
        "status": status,
        "content_type": content_type,
        "body": body,
        "error": p.stderr.strip() if p.returncode and p.stderr.strip() else None,
    }

def classify(item, result):
    url = item["url"]
    status = result["status"]
    body = result["body"]
    dash = url.lower().split("?", 1)[0].endswith(".mpd")
    if status == 200:
        live = is_live_dash(body) if dash else is_live_hls(body)
        return {
            "name": item["name"], "url": url, "live": live,
            "status": status, "content_type": result["content_type"],
            "error": None,
            "inactive_reason": None if live else ("DASH MPD is not live" if dash else "HLS playlist is not live"),
        }
    if status in (404, 410):
        return {
            "name": item["name"], "url": url, "live": False,
            "status": status, "content_type": result["content_type"],
            "error": None, "inactive_reason": f"HTTP {status}",
        }
    return {
        "name": item["name"], "url": url, "live": False,
        "status": status, "content_type": result["content_type"],
        "error": result["error"] or f"HTTP {status}",
        "inactive_reason": None,
    }

def load_proxies():
    data = json.loads(get_text(HPROXY_URL))
    proxies = []
    for row in data:
        if not row.get("ip") or not row.get("port"):
            continue
        protocols = row.get("protocols") or []
        protocol = row.get("protocol") or ""
        if "http" not in protocols and protocol != "http":
            continue
        proxies.append(f'{row["ip"]}:{row["port"]}')
    return proxies

def find_working_proxy(proxies):
    direct = curl_probe(EVENT7_URL)
    if direct["status"] == 200 and is_live_hls(direct["body"]):
        return None, "direct"

    def test(proxy):
        result = curl_probe(EVENT7_URL, proxy)
        if result["status"] == 200 and is_live_hls(result["body"]):
            return proxy, "event-07-live"
        if result["status"] in (404, 410):
            return proxy, "event-07-reachable-inactive"
        return None

    # Try many fresh Vietnam HTTP proxies concurrently. The target URL is always
    # the exact event-07 source URL; the proxy is transport only.
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(test, p) for p in proxies[:MAX_PROXY_TRIES]]
        for future in concurrent.futures.as_completed(futures):
            try:
                found = future.result()
                if found:
                    return found
            except Exception:
                pass

    return None, "no-working-proxy"

def scan_all(candidates, proxy):
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(curl_probe, item["url"], proxy): item
            for item in candidates
        }
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                results.append(classify(item, future.result()))
            except Exception as exc:
                results.append({
                    "name": item["name"], "url": item["url"], "live": False,
                    "status": 0, "content_type": "", "error": str(exc),
                    "inactive_reason": None,
                })
    order = {item["url"]: i for i, item in enumerate(candidates)}
    results.sort(key=lambda x: order.get(x["url"], 999999))
    return results

def build_m3u(results):
    lines = ["#EXTM3U", "#NM7-SCAN-VERIFIED: true", "#NM7-SCAN-MODE: vietnam-transport-source-only"]
    for row in results:
        if not row["live"]:
            continue
        lines.append(f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{row["name"]}')
        lines.append(row["url"])
    return "\n".join(lines) + "\n"

def main():
    source = get_text(SOURCE_URL)
    candidates = parse_source(source)
    if len(candidates) != 46:
        raise RuntimeError(f"Expected 46 exact source endpoints, got {len(candidates)}")

    proxies = load_proxies()
    proxy, selection = find_working_proxy(proxies)
    if selection == "no-working-proxy" and proxy is None:
        raise RuntimeError("FPT source cannot be reached from direct path or fresh Vietnam HTTP proxies")

    # Direct path may work; otherwise use a fresh Vietnam proxy as the transport only.
    results = scan_all(candidates, proxy)
    live = [x for x in results if x["live"]]
    errors = [x for x in results if x["error"]]
    all_403 = len(results) > 0 and all(x["status"] == 403 for x in results)

    status = {
        "service": "NM7 FPT Event Live Scanner",
        "scannerVersion": "source-probe-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": SOURCE_URL,
        "sourceOnly": True,
        "candidates": len(candidates),
        "liveEntries": len(live),
        "inactiveEntries": len([x for x in results if not x["live"] and not x["error"]]),
        "probeErrors": len(errors),
        "allProbeErrorsAre403": all_403,
        "scanHealthy": len(errors) == 0,
        "partialScan": len(errors) > 0 and len(live) > 0,
        "transport": selection,
        "liveChannels": [{"name": x["name"], "url": x["url"]} for x in live],
        "errors": results if len(results) <= 60 else results[:60],
    }

    os.makedirs(os.path.dirname(OUTPUT_M3U), exist_ok=True)
    os.makedirs(os.path.dirname(OUTPUT_STATUS), exist_ok=True)

    # Never replace a valid playlist with a false empty result while the current
    # network vantage is degraded. Only a clean scan or a partial scan with at
    # least one positively verified live URL may change the public live set.
    can_publish = (len(errors) == 0) or (len(live) > 0)
    if can_publish:
        with open(OUTPUT_M3U, "w", encoding="utf-8") as f:
            f.write(build_m3u(results))
    elif not os.path.exists(OUTPUT_M3U):
        raise RuntimeError(
            "No publishable live result: FPT/transport returned errors and no previous playlist exists"
        )

    with open(OUTPUT_STATUS, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "candidates": len(candidates),
        "liveEntries": len(live),
        "probeErrors": len(errors),
        "scanHealthy": status["scanHealthy"],
        "partialScan": status["partialScan"],
        "transport": selection,
        "proxyUsed": proxy is not None,
        "liveChannels": status["liveChannels"],
        "allProbeErrorsAre403": all_403,
        "publishedCurrentScan": can_publish,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
