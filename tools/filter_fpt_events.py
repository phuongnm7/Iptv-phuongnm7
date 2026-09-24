#!/usr/bin/env python3
import re, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://vips-livecdn.fptplay.net/live/media"
EVENTS = []
for i in range(1, 16):
    EVENTS.append((f"Sự kiện FPT {i:02d}", f"{BASE}/su-kien-{i:02d}/hls_avc_v6/index.m3u8"))
EVENTS += [
    ("Sự kiện FPT 4K 01", f"{BASE}/su-kien-01-4k/hls_avc_v6/index.m3u8"),
    ("Sự kiện FPT 4K 02", f"{BASE}/su-kien-02-4k/hls_avc_v6/index.m3u8"),
    ("Sự kiện FPT 4K 04", f"{BASE}/event-04-4k/hls_avc_v6/index.m3u8"),
]

UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/120 Safari/537.36"

def get_playlist(url):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"})
    with urlopen(req, timeout=10) as r:
        return r.read().decode("utf-8", "ignore")

def signature(txt):
    lines = [x.strip() for x in txt.splitlines() if x.strip() and not x.startswith("#")]
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt)
    return (seq.group(1) if seq else "", lines[-1] if lines else "")

def is_live(url):
    try:
        a = get_playlist(url)
        if "#EXTM3U" not in a or "#EXTINF:" not in a:
            return False
        if "#EXT-X-ENDLIST" in a:
            return False
        s1 = signature(a)
        time.sleep(4)
        b = get_playlist(url)
        if "#EXT-X-ENDLIST" in b:
            return False
        s2 = signature(b)
        # A moving media sequence or changing last segment is strong evidence of a live HLS playlist.
        return s1 != s2
    except (HTTPError, URLError, TimeoutError, Exception):
        return False

def main():
    live = []
    for name, url in EVENTS:
        ok = is_live(url)
        print(f"{'LIVE' if ok else 'OFF '}  {name}  {url}")
        if ok:
            live.append((name, url))

    out = ["#EXTM3U", ""]
    for name, url in live:
        out += [f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{name}', url, ""]
    with open("fpt-event-live.m3u", "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"Live events: {len(live)}")

if __name__ == "__main__":
    main()
