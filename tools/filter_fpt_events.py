#!/usr/bin/env python3
import re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin
from urllib.request import Request, urlopen

VIPS = "https://vips-livecdn.fptplay.net/live/media"
LIVECDN = "https://livecdn.fptplay.net/schedule"
CANDIDATES = []

def add(name, url, source):
    CANDIDATES.append((name, url, source))

for i in range(1, 51):
    n = f"{i:02d}"
    add(f"Sự kiện FPT {n}", f"{VIPS}/su-kien-{n}/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT {n}", f"{LIVECDN}/sukien{n}_vhls.smil/chunklist_b5000000.m3u8", "LIVECDN")
    add(f"Sự kiện FPT {n} 4K", f"{VIPS}/su-kien-{n}-4k/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT Event {n}", f"{VIPS}/event-{n}/hls_avc_v6/index.m3u8", "VIPS")
    add(f"Sự kiện FPT Event {n} 4K", f"{VIPS}/event-{n}-4k/hls_avc_v6/index.m3u8", "VIPS")

UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/120 Safari/537.36"

def get_text(url):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*", "Cache-Control": "no-cache"})
    with urlopen(req, timeout=10) as r:
        return r.read().decode("utf-8", "ignore")

def resolve_media(url):
    txt = get_text(url)
    if "#EXT-X-ENDLIST" in txt:
        return None
    if "#EXTINF:" in txt:
        return url, txt
    if "#EXT-X-STREAM-INF:" in txt:
        lines = [x.strip() for x in txt.splitlines() if x.strip()]
        variants = []
        for i, line in enumerate(lines[:-1]):
            if line.startswith("#EXT-X-STREAM-INF:") and not lines[i+1].startswith("#"):
                bw = re.search(r"BANDWIDTH=(\d+)", line)
                variants.append((int(bw.group(1)) if bw else 0, urljoin(url, lines[i+1])))
        if variants:
            variant = max(variants, key=lambda x: x[0])[1]
            media = get_text(variant)
            if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
                return variant, media
    return None

def live_check(item):
    name, url, source = item
    try:
        a = resolve_media(url)
        if not a:
            return None
        media_url, txt = a
        seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt)
        target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt)
        segs = [x.strip() for x in txt.splitlines() if x.strip() and not x.startswith("#")]
        if not segs:
            return None
        sig1 = (seq.group(1) if seq else "", segs[-1], len(segs))
        wait = min(max(float(target.group(1)) * 1.5 if target else 6, 6), 15)
        time.sleep(wait)
        b = resolve_media(url)
        if not b:
            return None
        _, txt2 = b
        seq2 = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", txt2)
        segs2 = [x.strip() for x in txt2.splitlines() if x.strip() and not x.startswith("#")]
        if not segs2:
            return None
        sig2 = (seq2.group(1) if seq2 else "", segs2[-1], len(segs2))
        return (name, url, source) if sig1 != sig2 else None
    except Exception:
        return None

def main():
    live = {}
    with ThreadPoolExecutor(max_workers=30) as pool:
        futures = {pool.submit(live_check, item): item for item in CANDIDATES}
        for f in as_completed(futures):
            item = futures[f]
            result = f.result()
            print(("LIVE " if result else "OFF  ") + item[0] + " [" + item[2] + "]")
            if result:
                name, url, source = result
                # Prefer the VIPS URL in output; LIVECDN is detection fallback.
                if name not in live or source == "VIPS":
                    live[name] = (name, url, source)

    if not live:
        print("No positive live detection: preserve existing playlist.")
        return

    out = ["#EXTM3U", ""]
    for name, url, source in sorted(live.values(), key=lambda x: x[0]):
        if source == "LIVECDN":
            m = re.search(r"/sukien(\d+)_vhls\.smil/", url)
            if m:
                url = f"{VIPS}/su-kien-{m.group(1)}/hls_avc_v6/index.m3u8"
        out += [f'#EXTINF:-1 group-title="SỰ KIỆN FPT",{name}', url, ""]

    with open("fpt-event-live.m3u", "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"Scanned: {len(CANDIDATES)}; Live: {len(live)}")

if __name__ == "__main__":
    main()
