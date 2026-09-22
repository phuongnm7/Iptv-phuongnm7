#!/usr/bin/env python3
import asyncio
import re
from pathlib import Path
from urllib.parse import unquote
from playwright.async_api import async_playwright

TARGETS = [
    ("S8 TV", "https://us8tv.com/vi-vn/"),
    ("Gà Vàng 33 TV", "https://gavangtva.in.net/"),
]
OUT = Path("sources/web-discovered.m3u")
UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Safari/537.36 NM7-IPTV-WebDiscovery/1.0"

def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()

def likely_stream(u):
    x = u.lower()
    return ".m3u8" in x or "/hls/" in x or "playlist.m3u" in x or "chunklist" in x

def extract_match(text):
    text = clean(text)
    patterns = [
        r"(\d{1,2}:\d{2}\s+\d{1,2}/\d{1,2}[^\n]{0,220})",
        r"((?:[A-ZÀ-Ỹ][^\n]{2,80})\s+(?:VS|vs|v)\s+(?:[A-ZÀ-Ỹ][^\n]{2,80}))",
    ]
    for p in patterns:
        m = re.search(p, text)
        if m:
            s = clean(m.group(1))
            s = re.sub(r"\s+(?:Xem ngay|ĐANG DIỄN RA|Bóng đá)\b.*$", "", s, flags=re.I)
            if len(s) >= 8:
                return s[:240]
    return "Sports live"

async def inspect_site(browser, group, root):
    context = await browser.new_context(user_agent=UA, viewport={"width": 390, "height": 844})
    page = await context.new_page()
    found = []
    current_text = ""

    async def response_handler(resp):
        u = unquote(resp.url).strip()
        if likely_stream(u):
            found.append((u, current_text))

    page.on("response", response_handler)

    try:
        await page.goto(root, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)

        current_text = clean(await page.locator("body").inner_text())
        html = await page.content()
        for u in re.findall(r'https?://[^"\s<>]+', html):
            u = unquote(u).strip("'\"")
            if likely_stream(u):
                found.append((u, current_text))

        labels = await page.locator("a,button").all_text_contents()
        clicked = 0

        for label in labels:
            if clicked >= 20:
                break
            t = clean(label)
            if not re.search(r"xem ngay|xem|live|trực tiếp|tham gia live", t, re.I):
                continue

            try:
                loc = page.get_by_text(t, exact=True).first
                if await loc.count() == 0:
                    continue

                before = page.url
                current_text = clean(await page.locator("body").inner_text())
                await loc.click(timeout=3000)
                await page.wait_for_timeout(3500)
                current_text = clean(await page.locator("body").inner_text())
                clicked += 1

                if page.url != before:
                    await page.go_back(wait_until="domcontentloaded", timeout=15000)
                    await page.wait_for_timeout(1000)
                    current_text = clean(await page.locator("body").inner_text())
            except Exception:
                continue

    except Exception as e:
        print(f"{group}: {type(e).__name__}: {e}")
    finally:
        try:
            title = clean(await page.title())
        except Exception:
            title = ""
        await context.close()

    out = []
    seen = set()
    for u, text in found:
        if not u.startswith(("http://", "https://")) or u in seen:
            continue
        seen.add(u)
        out.append((extract_match(text or title), group, u))
    return out

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
        rows = []
        for group, root in TARGETS:
            x = await inspect_site(browser, group, root)
            print(f"{group}: discovered {len(x)} HLS candidates")
            rows.extend(x)
        await browser.close()

    if not rows:
        print("No HLS stream discovered; preserving existing source.")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        if not OUT.exists():
            OUT.write_text("#EXTM3U\n", encoding="utf-8")
        return

    lines = ["#EXTM3U"]
    seen = set()
    for name, group, u in rows:
        key = (group, name, u)
        if key in seen:
            continue
        seen.add(key)
        safe_name = name.replace('"', "'")
        lines.append(f'#EXTINF:-1 group-title="{group}",{safe_name}')
        lines.append(u)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(seen)} entries to {OUT}")

if __name__ == "__main__":
    asyncio.run(main())
