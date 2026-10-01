# NM7 FPT Event Live — Cloudflare Worker

Worker tạo playlist **SỰ KIỆN FPT** từ đúng một file source:

`https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u`

## Quy tắc lọc live

Worker chỉ làm 3 việc:

1. Đọc các URL có trong source M3U.
2. Gọi **chính URL đó** để kiểm tra manifest.
3. Chỉ đưa URL đó vào playlist nếu manifest xác nhận đang live.

Worker **không** lấy danh sách event từ playlist khác, không đổi hostname, không suy đoán event từ ảnh/logo và không đưa last-known-good vào danh sách live hiện tại.

### HLS

Một entry được coi là live khi manifest hợp lệ là M3U8, không có `#EXT-X-ENDLIST`, không phải VOD và có tín hiệu media/stream.

### DASH

Một entry được coi là live khi MPD hợp lệ, không phải `type="static"` và có tín hiệu dynamic/live.

### Các trường hợp bị loại

- HTTP 404/410
- HTTP 403/401
- timeout/network error
- HTML hoặc dữ liệu không phải manifest
- HLS đã ENDLIST/VOD
- DASH static/non-live

**Quan trọng:** nếu FPT trả 403 cho cả 46 URL, playlist strict sẽ là **0 kênh**. Đây là kết quả đúng của bộ lọc, vì Worker không có bằng chứng để nói URL nào đang live.

## Cron

`*/5 * * * *`

Mỗi 5 phút Worker đọc lại source M3U và lọc lại từ đầu.

## Endpoint

Playlist chính:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u

Status:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status

Manual scan:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/scan

## Bảo vệ source-only

GitHub Actions kiểm tra rằng:

- workerVersion là `fpt-event-source-only-live-v11`;
- mọi URL trong playlist chính đều tồn tại trong source M3U;
- playlist không chứa hostname/nguồn event ngoài source;
- deploy không ép chạy thêm một full scan FPT.
