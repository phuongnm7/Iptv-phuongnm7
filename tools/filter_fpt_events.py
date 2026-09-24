#!/usr/bin/env python3
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode
from urllib.request import Request, urlopen

VIPS = "https://vips-livecdn.fptplay.net/live/media"
LIVECDN = "https://livecdn.fptplay.net/schedule"
GROUP = "SỰ KIỆN FPT"

CANDIDATES = []
def add(name, url, source):
    CANDIDATES.append((name, url, source))

# Probe a broad, deterministic range. FPT has historically exposed both
# "su-kien-XX" and "event-XX" families, including 4K variants.
for i in range(1, 51):
    n = f"{i:02d}"
    add(f"Sự kiện FPT {n}", f"{VIPS}/su-kien-{n}/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT {n}", f"{LIVECDN}/sukien{n}_vhls.smil/chunklist_b5000000.m3u8", "LIVECDN")
    add(f"Sự kiện FPT {n} 4K", f"{VIPS}/su-kien-{n}-4k/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT Event {n}", f"{VIPS}/event-{n}/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT Event {n} 4K", f"{VIPS}/event-{n}-4k/hls_avc_v6/index.m3u8", "VIPS")

UA = ("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36")

def cache_bust(url):
    p = urlsplit(url)
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    q["_nm7_probe"] = str(int(time.time() * 1000))
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q), p.fragment))

def get_text(url):
    req = Request(cache_bust(url), headers={
        "User-Agent": UA,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://fptplay.vn/",
        "Origin": "https://fptplay.vn",
    })
    with urlopen(req, timeout=8) as r:
        return r.read().decode("utf-8", "ignore")

def resolve_media(url):
    txt = get_text(url)
    if "#EXT-X-ENDLIST" in txt:
        return None
    if "#EXTINF:" in txt:
        return url, txt

    if "#EXT-X-STREAM-INF:" not in txt:
        return None

    lines = [x.strip() for x in txt.splitlines() if x.strip()]
    variants = []
    for i, line in enumerate(lines[:-1]):
        if line.startswith("#EXT-X-STREAM-INF:") and not lines[i + 1].startswith("#"):
            bw = re.search(r"BANDWIDTH=(\d+)", line)
            variants.append((int(bw.group(1)) if bw else 0, urljoin(url, lines[i + 1])))

    if not variants:
        return None

    # Prefer the highest bandwidth rendition.
    variant = max(variants, key=lambda x: x[0])[1]
    media = get_text(variant)
    if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
        return variant, media
    return None

def signature(txt):
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt)
    pdt = re.findall(r"#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)", txt)
    segs = [x.strip() for x in txt.splitlines()
            if x.strip() and not x.startswith("#")]
    if not segs:
        return None
    return (
        seq.group(1) if seq else "",
        pdt[-1] if pdt else "",
        segs[-1],
        len(segs),
    )

def live_check(item):
    name, url, source = item
    try:
        first = resolve_media(url)
        if not first:
            return None

        media_url, txt1 = first
        sig1 = signature(txt1)
        if not sig1:
            return None

        target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt1)
        # Keep the probe quick, but long enough for normal 4–6s HLS segments.
        wait = min(max(float(target.group(1)) * 1.2 if target else 5.0, 4.0), 9.0)
        time.sleep(wait)

        second = resolve_media(url)
        if not second:
            return None
        _, txt2 = second
        sig2 = signature(txt2)
        if not sig2:
            return None

        # A moving media sequence/newest segment is definitive. A changing
        # program-date-time is also sufficient when sequence numbers are absent.
        if sig1 != sig2:
            return (name, url, source)

        return None
    except Exception as exc:
        print(f"PROBE_ERROR {source} {name}: {type(exc).__name__}: {exc}")
        return None

def display_url(name, verified_url, source):
    # Prefer LIVECDN direct media playlists for standard su-kien-XX events.
    # They are single media playlists and are more compatible with IPTV
    # players than a VIPS master whose audio may be represented separately.
    return verified_url

def main():
    live = {}

    # Avoid hammering FPT with 250 simultaneous requests.
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(live_check, item): item for item in CANDIDATES}
        for future in as_completed(futures):
            item = futures[future]
            result = future.result()
            if result:
                name, verified_url, source = result
                out_url = display_url(name, verified_url, source)
                # Prefer non-4K VIPS over fallback duplicates; otherwise keep
                # the first verified result for the same display name.
                if name not in live or source == "LIVECDN":
                    live[name] = (name, out_url)

    if not live:
        # NEVER erase a working playlist because the CDN temporarily rejects
        # GitHub's runner or a probe times out.
        print("NO_POSITIVE_DETECTION - PRESERVE EXISTING PLAYLIST")
        return

    lines = ["#EXTM3U", ""]
    for name, url in sorted(live.values(), key=lambda x: x[0].lower()):
        lines += [f'#EXTINF:-1 group-title="{GROUP}",{name}', url, ""]

    with open("fpt-event-live.m3u", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Scanned {len(CANDIDATES)} endpoints; detected {len(live)} live streams.")

if __name__ == "__main__":
    main()
