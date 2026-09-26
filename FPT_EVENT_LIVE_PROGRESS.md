# NM7 FPT Event Live — Progress

## 2026-09-26

### Baseline problem
- GitHub Actions workflow `.github/workflows/update-fpt-event-live.yml` used `*/5 * * * *`.
- Historical runs showed long gaps, so the 5-minute schedule was not dependable.
- A successful GitHub run only proved that `curl` received HTTP success; the Worker could still report probe errors.
- The existing Worker source already had the correct 250-candidate / 5-batch architecture, but it did not define a real Cloudflare Cron Trigger.
- The Worker performed an exact fetch and then a cache-busted retry, which could create unnecessary subrequests.

### Implemented
1. Cloudflare Worker now has `scheduled()` and owns the automatic scan schedule.
2. `wrangler.jsonc` now defines `* * * * *`.
3. One batch is scanned per minute using `scheduledTime minute % 8`.
4. Full 250-candidate coverage is therefore completed every ~8 minutes.
5. Each candidate uses one no-store/cache-bypass HLS request.
6. Only confirmed HLS playlists are published.
7. 404/410, ended playlists, VOD playlists, invalid playlists, and probe errors are excluded from the published batch.
8. Each batch KV record expires after 15 minutes.
9. Playlist generation requires all 8 batches to be fresh within 11 minutes; otherwise the playlist endpoint returns HTTP 503 rather than serving an incomplete/stale playlist.
10. `/status` now exposes batch freshness, live count, inactive count, and error count.
11. GitHub Actions was changed from scheduled execution to manual fallback and now validates the Worker JSON instead of treating HTTP 200 alone as success.
12. FPT Worker README was updated with the new automatic architecture.

### Commits
- Worker logic: `947105b4468d07e871dd271359d3ea1d03a0f2d5` + `d4a5fc94429a74c0d54a6c78587348aa20598297`
- Cron configuration: `5877dbdbf97df538a174bfbd2e9e45dd73d053f8`
- Manual GitHub fallback: `a9b631b15ef2c999a59df7b712829586cdbb27ee`
- Documentation: `e6070c93515f3918959ebc213047d3e074234dde`

### 2026-09-26 — Subrequest-limit fix
- Runtime verification showed exactly 10 probe errors in every 50-candidate batch.
- Cloudflare Free allows 50 external subrequests per invocation, and redirect chains count additional subrequests. A 50-candidate batch therefore had no safety margin.
- Scanner changed to 8 batches: 32 candidates per batch for the first 7 batches and 26 in the final batch. Full coverage remains 250 candidates every ~8 minutes.
- Batch records now retain up to 12 error details in `/status` so any remaining probe problem can be identified by URL/source instead of only a count.
- The Worker must be redeployed after this code change before runtime can be re-tested.

### Verification still required after Cloudflare deploy
Open:

- `https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status`
- `https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u`

Expected after the first complete cycle:
- `ready: true`
- `batchesReady: 8`
- `candidates: 250`
- `batchErrors` should be all zero; if not, inspect `errorDetails`
- `liveEntries` = current confirmed FPT events

Cloudflare Cron Trigger changes can take several minutes to propagate after deployment.

### Important
The authoritative automatic playlist is the Cloudflare Worker URL above. The repository file `fpt-event-live.m3u` remains a static GitHub snapshot and is not the source of truth for the automatic runtime playlist.
