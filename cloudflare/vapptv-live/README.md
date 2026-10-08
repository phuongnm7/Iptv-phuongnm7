# NM7 vAppTV Dynamic Playlist

Dynamic Cloudflare Worker that reads the current vAppTV channel catalog from:

https://freem3u.xyz/api/channels/x_1.0.1/app.json

## Endpoints

- `/playlist.m3u` — current channel list, groups, logos and stable per-channel dynamic URLs.
- `/stream?id=<channel-id>` — resolves that channel's current playable source at playback time.
- `/proxy?u=<url>&h=<header-token>` — internal HLS manifest/segment proxy for sources that need HTTP headers.
- `/health` — health information.

The playlist itself performs only one external request to the vAppTV catalog. Source resolution happens per-channel when NM7 opens the stream, so an upstream channel URL change does not require rebuilding the playlist.

The Worker preserves the app's configured group order and also preserves secondary groups found on channel objects.
