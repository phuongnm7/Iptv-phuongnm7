#!/usr/bin/env python3
import re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://vips-livecdn.fptplay.net/live/media"
CANDIDATES = []

def add(name, path):
    CANDIDATES.append((name, f"{BASE}/{path}/hls_avc_v6/index.m3u8"))

# Broad scan: numbered FPT event and 4K naming patterns.
for i in range(1, 51):
    n = f"{i:02d}"
    add(f"Sự kiện FPT {n}", f"su-kien-{n}")
    add(f"Sự kiện FPT {n} 4K", f"su-kien-{n}-4k")
    add(f"FPT Event {n}", f"event-{n}")
    add(f"FPT Event {n} 4K", f"event-{n}-4k")

UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/120 Safari/537.36"
TIMEOUT = 8

def get_playlist(url):
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        "Cache-Control": "no-cache",
    })
    with urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "ignore")

def playlist_info(txt):
    if "#EXTM3U" not in txt or "#EXTINF:" not in txt or "#EXT-X-ENDLIST" in txt:
        return None
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt)
    target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt)
    segments = [x.strip() for x in txt.splitlines() if x.strip() and not x.startswith("#")]
    if not segments:
        return None
    return {
        "seq": int(seq.group(1)) if seq else None,
        "last": segments[-1],
        "target": float(target.group(1)) if target else 6.0,
        "count": len(segments),
    }

def is_live(item):
    name, url = item
    try:
        first = playlist_info(get_playlist(url))
        if not first:
            return None
        # Wait for a real HLS segment rotation; no fixed 4-second assumption.
        wait = min(max(first["target"] * 1.5, 5.0), 12.0)
        time.sleep(wait)
        second = playlist_info(get_playlist(url))
        if not second:
            return None
        moving = (
            first["seq"] != second["seq"]
            or first["last"] != second["last"]
            or first["count"] != second["count"]
        )
        return (name, url) if moving else None
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
    for name, url in live:
        out += [f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{name}', url, ""]
    with open("fpt-event-live.m3u", "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    print(f"Scanned candidates: {len(CANDIDATES)}")
    print(f"Live events: {len(live)}")

if __name__ == "__main__":
    main()
