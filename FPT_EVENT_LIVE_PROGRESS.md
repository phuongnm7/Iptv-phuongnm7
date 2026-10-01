# NM7 FPT Event Live — Progress

## 2026-10-01 — v7 subrequest-safe fix

### Runtime evidence
- Production /status reported 46 candidates: 38 HLS + 8 DASH.
- liveEntries = 0 and playlistEntries = 0.
- probeErrors = 46.
- Every reported probe error was:
  "Too many subrequests by single Worker invocation."
- Therefore the failure was in the probe architecture, not evidence that all 46 FPT sources were offline.

### Root causes isolated
1. scan() used Promise.all(candidates.map(probe)) and launched all endpoint probes together.
2. probe() could retry the same endpoint across three User-Agent values on 401/403.
3. Each manifest fetch used redirect: "follow", so redirect chains could consume extra subrequests.
4. The source fetch plus 46 probes had almost no margin under the Workers Free 50 external-subrequest limit.
5. scheduled() caught and swallowed scan failures inside waitUntil(), so a real scan failure could be recorded as a successful Cron invocation.
6. README and the actual deployed source had drifted: README described an older 250-candidate batch architecture while the current Worker source had 46 direct candidates and a 5-minute Cron.

### v7 implemented
- Worker version: fpt-event-resilient-v7-subrequest-safe.
- Full 46-endpoint scan remains every 5 minutes.
- Maximum 5 endpoint probes run concurrently.
- One primary probe per endpoint.
- Maximum 2 fallback probes per invocation for 401/403 or redirect cases.
- Manifest fetches use redirect: "manual" to avoid hidden redirect subrequests.
- External subrequest safety budget is hard-capped at 49, leaving a margin below the Workers Free 50-request limit.
- Current source size above the safe full-scan capacity fails explicitly instead of silently skipping endpoints.
- Duplicate source URLs are removed before probing.
- 8-second per-probe timeout added.
- HTTP 200 with non-M3U/non-MPD content is treated as probe error, not as clean inactive.
- If all probes fail specifically because of a subrequest-limit condition, the previous good playlist is preserved.
- Individual endpoint errors do not preserve unrelated stale channels; only currently confirmed live results are published.
- /status now exposes probe budget, concurrency, fallback usage, scan health, scan duration, protocol statistics and DASH diagnostics.
- scheduled() now rethrows after recording failure so Cron Past Events can reflect a real failure.

### Validation performed locally
- Syntax check passed for the new Worker source.
- Mock full-scan test: 46 candidates, 5-way concurrency, 47 external requests when no fallback is needed; playlist/result counts matched.
- Quota-failure test: 46 probe errors were handled without exceeding 47 external requests; the last good playlist remained intact.
- Fallback budget test reached the hard ceiling of 49 external requests and did not exceed it.

### GitHub updates
- cloudflare/fpt-event-worker/src/index.js updated to v7.
- .github/workflows/deploy-fpt-event-worker.yml updated to verify v7 and enforce the declared subrequest budget.
- cloudflare/fpt-event-worker/README.md rewritten to match the real 46-endpoint architecture.
- This progress file updated with the diagnosis and validation.

### Deployment
The source changes are committed on main. The deploy workflow is configured to run on changes under cloudflare/fpt-event-worker and then call /scan for post-deploy verification.

### Next production verification
After the GitHub Actions deployment completes, /status should show:
- workerVersion = fpt-event-resilient-v7-subrequest-safe
- candidates = 46 (unless the source file changes)
- subrequestBudget.maxExternalSubrequests = 49
- subrequestBudget.used <= 49
- probeErrors reported per actual source condition
- protocolStats showing 38 HLS + 8 DASH
- liveEntries = currently confirmed live events
- /fpt-event-live.m3u containing only the entries accepted by the current scan

If the FPT CDN itself changes its response format or starts requiring additional authorization/signatures, that is a separate source-access issue and will be visible in the per-endpoint diagnostics rather than being masked as a quota failure.
