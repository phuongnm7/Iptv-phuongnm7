#!/usr/bin/env python3
import re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://vips-livecdn.fptplay.net/live/media"
CANDIDATES = []

def add(name, path, kind):
    CANDIDATES.append((name, f"{BASE}/{path}/hls_avc_v6/index.m3u8", kind))

# Both URL naming families are placed in ONE playlist group: SỰ KIỆN FPT.
for i in range(1, 51):
    n = f"{i:02d}"
    add(f"Sự kiện FPT {n}", f"su-kien-{n}", "EVENT")
    add(f"Sự kiện FPT {n} 4K", f"su-kien-{n}-4k", "EVENT_4K")
    add(f"Sự kiện FPT Event {n}", f"event-{n}", "EVENT")
    add(f"Sự kiện FPT Event {n} 4K", f"event-{n}-4k", "EVENT_4K")

UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/120 Safari/537.36"
TIMEOUT = 10

def get_text(url):
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        "Cache-Control": "no-cache",
    })
    with urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "ignore")

def resolve_media_playlist(url):
    """Return a media playlist even when the supplied index.m3u8 is a master playlist."""
    txt = get_text(url)
    if "#EXT-X-ENDLIST" in txt:
        return None

    if "#EXTINF:" in txt:
        return url, txt

    # FPT may return a master playlist at index.m3u8.
    if "#EXT-X-STREAM-INF:" in txt:
        lines = [x.strip() for x in txt.splitlines() if x.strip()]
        variants = []
        for i, line in enumerate(lines[:-1]):
            if line.startswith("#EXT-X-STREAM-INF:"):
                uri = lines[i + 1]
                if uri and not uri.startswith("#"):
                    bw = re.search(r"BANDWIDTH=(\d+)", line)
                    variants.append((int(bw.group(1)) if bw else 0, urljoin(url, uri)))
        if variants:
            # Prefer the highest advertised variant.
            variant_url = max(variants, key=lambda x: x[0])[1]
            media = get_text(variant_url)
            if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
                return variant_url, media

    return None

def playlist_info(url):
    resolved = resolve_media_playlist(url)
    if not resolved:
        return None

    media_url, txt = resolved
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt)
    target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt)
    segments = [x.strip() for x in txt.splitlines() if x.strip() and not x.startswith("#")]
    if not segments:
        return None

    return {
        "url": media_url,
        "seq": int(seq.group(1)) if seq else None,
        "last": segments[-1],
        "target": float(target.group(1)) if target else 6.0,
        "count": len(segments),
    }

def is_live(item):
    name, url, kind = item
    try:
        first = playlist_info(url)
        if not first:
            return None

        # Give the live HLS playlist enough time to rotate at least one segment.
        wait = min(max(first["target"] * 1.5, 6.0), 15.0)
        time.sleep(wait)

        second = playlist_info(url)
        if not second:
            return None

        moving = (
            first["seq"] != second["seq"]
            or first["last"] != second["last"]
            or first["count"] != second["count"]
        )
        return (name, url, kind) if moving else None

    except (HTTPError, URLError, TimeoutError, OSError, UnicodeError):
        return None
    except Exception:
        return None

def main():
    live = []
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(is_live, item): item for item in CANDIDATES}
        for future in as_completed(futures):
            item = futures[future]
            result = future.result()
            print(f"{'LIVE' if result else 'OFF '} {item[0]} {item[1]}")
            if result:
                live.append(result)

    live.sort(key=lambda x: x[0])
    out = ["#EXTM3U", ""]
    for name, url, kind in live:
        out += [f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{name}', url, ""]

    with open("fpt-event-live.m3u", "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    print(f"Scanned candidates: {len(CANDIDATES)}")
    print(f"Live events: {len(live)}")

if __name__ == "__main__":
    main()
