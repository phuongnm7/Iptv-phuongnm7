# NM7 FPT Event Live — Cloudflare Worker

Worker này là bộ máy tự động chính cho playlist **SỰ KIỆN FPT**.

## Mục tiêu

- Quét toàn bộ 250 candidate HLS endpoint của FPT.
- Chỉ công bố stream đã xác nhận là playlist HLS hợp lệ.
- Sự kiện đã kết thúc, 404/410 hoặc không còn là playlist live sẽ bị loại khỏi playlist ở lần quét tiếp theo.
- Tự động chạy bằng Cloudflare Cron Trigger, không phụ thuộc lịch schedule của GitHub Actions.
- Chỉ phục vụ playlist khi đủ 5 batch mới, tránh trả về playlist thiếu sự kiện hoặc chứa dữ liệu quá cũ.

## Kiến trúc hiện tại

- **250 candidate endpoint**.
- Chia thành **5 batch × 50 endpoint**.
- Cloudflare Worker có **1 Cron Trigger chạy mỗi phút**.
- Mỗi phút Worker quét đúng 1 batch theo:
  - phút UTC % 5 = 0 → batch 0
  - phút UTC % 5 = 1 → batch 1
  - phút UTC % 5 = 2 → batch 2
  - phút UTC % 5 = 3 → batch 3
  - phút UTC % 5 = 4 → batch 4
- Như vậy toàn bộ 250 endpoint được quét một lần trong khoảng **5 phút**.
- Mỗi batch ghi một KV key riêng.
- KV batch tự hết hạn sau 10 phút nếu không được quét lại.
- Playlist chỉ được coi là ready khi cả 5 batch đều được cập nhật trong vòng 8 phút.
- Mỗi request HLS chỉ thực hiện một subrequest cho mỗi candidate để không vượt giới hạn Workers Free 50 subrequests/invocation.

## Playlist

Playlist động:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u

Trạng thái:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status

Quét thủ công một batch:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/scan?batch=0

### Quy tắc playlist

Worker không giữ lại stream cũ chỉ vì lần quét trước từng thấy nó live.

Mỗi batch được ghi đè bằng kết quả quét mới:

- live → đưa vào playlist.
- inactive → không đưa vào playlist.
- HTTP 404/410 → không đưa vào playlist.
- HTTP/network error → không đưa vào playlist và được ghi nhận trong errorCount.

Nếu một batch bị lỗi hoặc quá cũ, playlist /fpt-event-live.m3u trả HTTP 503 thay vì phục vụ playlist không đầy đủ. Điều này ưu tiên mục tiêu **đủ sự kiện và không giữ sự kiện stale**.

## Nguồn URL

### VIPS

Worker ưu tiên master URL:

https://vips-livecdn.fptplay.net/live/media/.../hls_avc_v6/index.m3u8

Không xuất child AVC rendition làm URL chính, giúp tránh lỗi lịch sử kiểu hình có nhưng mất tiếng khi player chọn nhầm rendition.

### LIVECDN

Vẫn quét:

https://livecdn.fptplay.net/schedule/sukienXX_vhls.smil/chunklist_b5000000.m3u8

Khi cùng một sự kiện có cả VIPS và LIVECDN, Worker ưu tiên URL VIPS master.

## Kiểm tra live/inactive

Worker kiểm tra:

- HTTP status.
- #EXTM3U.
- #EXTINF: hoặc #EXT-X-STREAM-INF:.
- Không có #EXT-X-ENDLIST.
- Không có #EXT-X-PLAYLIST-TYPE:VOD.

Điều này giúp loại các playlist đã kết thúc hoặc không còn là live playlist.

## GitHub Actions

.github/workflows/update-fpt-event-live.yml **không còn dùng schedule làm bộ máy chính**.

GitHub Actions hiện chỉ là **fallback/manual scanner**:

- workflow_dispatch để chạy thủ công.
- 5 batch chạy song song.
- Kiểm tra JSON trả về từ Worker.
- Kiểm tra đúng 50 candidate/batch.
- Nếu Worker báo probe error, job sẽ fail thay vì hiện xanh giả.

Lý do chuyển lịch chính sang Cloudflare: GitHub schedule có thể bị trì hoãn hoặc bị bỏ trong thời điểm Actions tải cao.

## Deploy

Từ thư mục:

cloudflare/fpt-event-worker

Deploy:

npx wrangler deploy

Sau khi deploy, vào Cloudflare Worker:

**Settings → Triggers → Cron Triggers**

xác nhận có:

* * * * *

## Kiểm tra sau deploy

1. Mở /status.
2. Chờ đủ 5 batch.
3. ready phải trở thành true.
4. batchesReady phải là 5.
5. candidates phải là 250.
6. batchErrors nên là 0.
7. liveEntries là số sự kiện đang được xác nhận.
8. Mở /fpt-event-live.m3u và kiểm tra playlist.

## Trạng thái

**Mục tiêu của bản này:** Cloudflare Worker là nguồn cập nhật tự động chính; GitHub Actions chỉ giữ vai trò kiểm tra/chạy tay.

Không cần commit fpt-event-live.m3u liên tục vào GitHub để playlist động hoạt động.
