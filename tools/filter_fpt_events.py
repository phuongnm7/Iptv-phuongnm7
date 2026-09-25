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


def _master_variants(url, txt):
    lines = [x.strip() for x in txt.splitlines() if x.strip()]
    audio_groups = set()
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line:
            m = re.search(r'GROUP-ID="([^"]+)"', line)
            if m:
                audio_groups.add(m.group(1))

    variants = []
    for i, line in enumerate(lines[:-1]):
        if not line.startswith("#EXT-X-STREAM-INF:"):
            continue
        if lines[i + 1].startswith("#"):
            continue
        bw = re.search(r"BANDWIDTH=(\d+)", line)
        codecs = re.search(r'CODECS="([^"]+)"', line)
        audio = re.search(r'AUDIO="([^"]+)"', line)
        variants.append({
            "bandwidth": int(bw.group(1)) if bw else 0,
            "codecs": codecs.group(1).lower() if codecs else "",
            "audio_group": audio.group(1) if audio else "",
            "url": urljoin(url, lines[i + 1]),
        })
    return variants, audio_groups


def resolve_media(url):
    """
    Return (playlist_url_for_player, media_url_for_probe, media_text).

    The previous implementation selected the highest-bandwidth video rendition
    from a master playlist and published that rendition directly. FPT's HLS
    masters can expose video-only AVC renditions, which produces picture with
    no sound. When an audio group is present, publish the master URL so the
    player can combine video + audio. When a rendition itself contains AAC,
    publishing that rendition is safe.
    """
    txt = get_text(url)
    if "#EXT-X-ENDLIST" in txt:
        return None

    if "#EXTINF:" in txt:
        return url, url, txt

    if "#EXT-X-STREAM-INF:" not in txt:
        return None

    variants, audio_groups = _master_variants(url, txt)
    if not variants:
        return None

    # IMPORTANT: FPT masters may advertise mp4a in CODECS even when the
    # audio is delivered as a separate EXT-X-MEDIA rendition. In that case,
    # publishing the child AVC URL causes video-only playback. Audio-group
    # linkage therefore takes precedence over CODECS-based muxed detection.
    with_audio_group = [
        v for v in variants
        if v["audio_group"] and v["audio_group"] in audio_groups
    ]
    if with_audio_group:
        chosen = max(with_audio_group, key=lambda x: x["bandwidth"])
        media = get_text(chosen["url"])
        if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
            return url, chosen["url"], media

    # Only use a child rendition when the master has no separate audio group
    # and the rendition explicitly declares an audio codec.
    muxed = [
        v for v in variants
        if "mp4a." in v["codecs"] or "ac-3" in v["codecs"] or "ec-3" in v["codecs"]
    ]
    if muxed:
        chosen = max(muxed, key=lambda x: x["bandwidth"])
        media = get_text(chosen["url"])
        if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
            return chosen["url"], chosen["url"], media

    # Fallback for masters without explicit audio metadata.
    chosen = max(variants, key=lambda x: x["bandwidth"])
    media = get_text(chosen["url"])
    if "#EXTINF:" in media and "#EXT-X-ENDLIST" not in media:
        return chosen["url"], chosen["url"], media
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
    """Return ('live'|'inactive'|'error', optional player URL)."""
    try:
        first = resolve_media(url)
        if not first:
            return "inactive", None

        player_url, _, txt1 = first
        sig1 = signature(txt1)
        if not sig1:
            return "inactive", None

        target = re.search(r"#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)", txt1)
        wait = min(max(float(target.group(1)) * 1.2 if target else 5.0, 4.0), 9.0)
        time.sleep(wait)

        second = resolve_media(url)
        if not second:
            return "inactive", None

        player_url2, _, txt2 = second
        sig2 = signature(txt2)
        if not sig2:
            return "inactive", None

        if sig1 != sig2:
            return "live", player_url2 or player_url

        # A static/ended playlist is not a currently live event.
        return "inactive", None
    except HTTPError as exc:
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
                kept.append((name, url))
            elif status == "live" and resolved:
                kept.append((name, resolved))
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

    # A newly discovered stream for the same event name must replace an old
    # published rendition. This is important when an older playlist contains
    # a video-only child URL: the newly discovered master URL must win.
    by_name = {}
    for name, url in kept_existing:
        by_name[name] = (name, url)
    for name, url in discovered.values():
        by_name[name] = (name, url)

    total_errors = candidate_errors + existing_errors

    if not discovered and not existing and total_errors:
        raise SystemExit(
            f"FPT scan incomplete: {total_errors} probe errors and no existing "
            "playlist to validate; refusing to publish an empty playlist."
        )

    count = write_playlist(list(by_name.values()))

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
