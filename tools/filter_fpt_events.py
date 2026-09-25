#!/usr/bin/env python3
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode
from urllib.request import Request, urlopen

VIPS = "https://vips-livecdn.fptplay.net/live/media"
LIVECDN = "https://livecdn.fptplay.net/schedule"
GROUP = "SỰ KIỆN FPT"
PLAYLIST = "fpt-event-live.m3u"

CANDIDATES = []
def add(name, url, source):
    CANDIDATES.append((name, url, source))

# Probe standard, 4K and EVENT endpoint families.
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
            variants.append((int(bw.group(1)) if bw else 0,
                             urljoin(url, lines[i + 1])))

    if not variants:
        return None

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
    return (seq.group(1) if seq else "", pdt[-1] if pdt else "",
            segs[-1], len(segs))


def probe_url(name, url, source="existing"):
    """Return ('live'|'inactive'|'error', optional resolved URL)."""
    try:
        first = resolve_media(url)
        if not first:
            return "inactive", None

        resolved, txt1 = first
        sig1 = signature(txt1)
        if not sig1:
            return "inactive", None

        target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt1)
        wait = min(max(float(target.group(1)) * 1.2 if target else 5.0, 4.0), 9.0)
        time.sleep(wait)

        second = resolve_media(url)
        if not second:
            return "inactive", None

        resolved2, txt2 = second
        sig2 = signature(txt2)
        if not sig2:
            return "inactive", None

        if sig1 != sig2:
            return "live", resolved2 or resolved

        # A static/ended playlist is not a currently live event.
        return "inactive", None
    except HTTPError as exc:
        # 404/410 are authoritative "not available" responses.
        if exc.code in (404, 410):
            return "inactive", None
        print(f"PROBE_ERROR {source} {name}: HTTP {exc.code}")
        return "error", None
    except (URLError, TimeoutError, OSError) as exc:
        print(f"PROBE_ERROR {source} {name}: {type(exc).__name__}: {exc}")
        return "error", None
    except Exception as exc:
        print(f"PROBE_ERROR {source} {name}: {type(exc).__name__}: {exc}")
        return "error", None


def load_existing():
    entries = []
    try:
        with open(PLAYLIST, "r", encoding="utf-8") as f:
            lines = [x.strip() for x in f]
    except FileNotFoundError:
        return entries

    current_name = None
    for line in lines:
        if line.startswith("#EXTINF:"):
            current_name = line.split(",", 1)[1].strip() if "," in line else "Sự kiện FPT"
        elif line and not line.startswith("#") and current_name:
            entries.append((current_name, line))
            current_name = None
    return entries


def scan_candidates():
    live = {}
    errors = 0
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {
            pool.submit(probe_url, name, url, source): (name, url, source)
            for name, url, source in CANDIDATES
        }
        for future in as_completed(futures):
            name, url, source = futures[future]
            status, resolved = future.result()
            if status == "error":
                errors += 1
            elif status == "live" and resolved:
                # Prefer LIVECDN for standard su-kienXX because it has
                # proven audio compatibility with NM7.
                if name not in live or source == "LIVECDN":
                    live[name] = (name, resolved)
    return live, errors


def validate_existing(entries):
    """Re-check previously published events so ended events are removed."""
    kept = []
    errors = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(probe_url, name, url, "existing"): (name, url)
            for name, url in entries
        }
        for future in as_completed(futures):
            name, url = futures[future]
            status, resolved = future.result()
            if status == "error":
                errors += 1
                # Never delete a previously published event because of a
                # temporary network/CDN failure.
                kept.append((name, url))
            elif status == "live" and resolved:
                kept.append((name, resolved))
            # inactive => event has ended; intentionally omit it.
    return kept, errors


def write_playlist(entries):
    unique = []
    seen = set()
    for name, url in sorted(entries, key=lambda x: (x[0].lower(), x[1])):
        if url in seen:
            continue
        seen.add(url)
        unique.append((name, url))

    lines = ["#EXTM3U", ""]
    for name, url in unique:
        lines += [f'#EXTINF:-1 group-title="{GROUP}",{name}', url, ""]
    with open(PLAYLIST, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return len(unique)


def main():
    existing = load_existing()
    discovered, candidate_errors = scan_candidates()
    kept_existing, existing_errors = validate_existing(existing)

    # New live events are authoritative additions. Previously published
    # events survive only when they still probe as live, or when their probe
    # failed transiently. This makes event removal automatic without allowing
    # a temporary CDN/network problem to erase the playlist.
    combined = kept_existing + list(discovered.values())

    # De-duplicate by URL and prefer discovered URLs when available.
    by_url = {}
    for name, url in combined:
        by_url[url] = (name, url)

    total_errors = candidate_errors + existing_errors

    # If the repository has no prior playlist and the scanner is experiencing
    # transient failures, do not publish an empty playlist. A real successful
    # scan with no live events is allowed to publish an empty playlist.
    if not discovered and not existing and total_errors:
        raise SystemExit(
            f"FPT scan incomplete: {total_errors} probe errors and no existing "
            "playlist to validate; refusing to publish an empty playlist."
        )

    count = write_playlist(list(by_url.values()))

    print(
        f"Scanned {len(CANDIDATES)} candidate endpoints; "
        f"discovered {len(discovered)} live streams; "
        f"kept {len(kept_existing)} existing streams; "
        f"published {count} streams; "
        f"probe errors={total_errors}."
    )

    if total_errors:
        print("NOTE: transient probe errors were detected; affected existing "
              "entries were preserved instead of being deleted.")


if __name__ == "__main__":
    main()
