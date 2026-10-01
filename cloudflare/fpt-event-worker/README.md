# NM7 FPT Event Live — Cloudflare Worker

Worker tạo playlist **SỰ KIỆN FPT** từ đúng source M3U của repo và quét lại mỗi 5 phút.

## Source duy nhất

Worker chỉ đọc:

https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u

Source hiện có 46 URL duy nhất: 38 HLS và 8 DASH.

Không dùng:
- playlist metadata bên ngoài;
- `vhd0/Stuff`;
- `vuminhthanh12/vmttv`;
- hostname FPT thay thế;
- URL không có trong source;
- last-known-good như bằng chứng rằng event hiện đang live.

## Cách xác định live

Mỗi chu kỳ Worker lấy lại source và probe **toàn bộ 46 URL đúng nguyên văn**.

HLS được chấp nhận khi:
- response là manifest `#EXTM3U`;
- không có `#EXT-X-ENDLIST`;
- không phải `#EXT-X-PLAYLIST-TYPE:VOD`;
- có segment, variant hoặc media-sequence.

DASH được chấp nhận khi:
- response là MPD hợp lệ;
- không phải `type="static"`;
- có tín hiệu live như `dynamic`, `minimumUpdatePeriod`, `timeShiftBufferDepth`, `availabilityStartTime` hoặc `suggestedPresentationDelay`;
- có cấu trúc media.

URL nào được xác minh live trong **chính lần quét hiện tại** thì được đưa vào playlist. URL 403/401/timeout/HTTP lỗi hoặc manifest không live bị loại khỏi playlist. Không có việc suy đoán một URL đang live chỉ vì nó từng live trước đó.

### Partial scan

Nếu một số URL bị 403 nhưng vẫn có một hoặc nhiều URL khác trả về manifest live hợp lệ, Worker vẫn xuất bản **chỉ các URL đã xác minh live**.

Trạng thái:
- `scanHealthy=false`: chưa xác minh được toàn bộ 46 URL.
- `partialScan=true`: có ít nhất một URL live đã xác minh trong khi một số URL khác chưa xác minh.
- Header strict playlist dùng `X-NM7-FPT-Filter: partial-scan-confirmed-live-only`.

Nếu cả 46 URL đều bị 403 hoặc không có URL live nào xác minh được, strict playlist sẽ không chứa các event cũ như thể chúng vẫn đang live.

## Subrequest budget

Cloudflare Workers Free có giới hạn external subrequests mỗi invocation. Worker tự giới hạn ở 49 request:
- 1 request lấy source;
- tối đa 46 probe chính;
- tối đa 2 probe retry cho 401/redirect;
- concurrency tối đa 3;
- timeout mỗi probe 8 giây;
- redirect dùng `manual` để tránh subrequest ẩn.

Nếu source tăng vượt kích thước quét an toàn, Worker fail rõ ràng thay vì âm thầm bỏ qua URL.

## Cron

```
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

Cron chạy theo UTC.

## Endpoint

Strict live playlist:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u

Fallback riêng:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-fallback.m3u

Status:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status

Manual scan:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/scan

## Headers

Strict playlist trả:
- `X-NM7-FPT-Events`
- `X-NM7-FPT-Verified`
- `X-NM7-FPT-Filter`
- `X-NM7-FPT-Version`

## Worker version

Version hiện tại: `fpt-event-source-proven-live-v12`.

## CI/CD

GitHub Actions:
- chạy `node --check`;
- deploy Wrangler;
- xác nhận worker version v12;
- kiểm tra mọi URL trong strict playlist đều tồn tại nguyên văn trong source;
- chặn các dấu vết của metadata/alternate-source cũ;
- thực hiện một current-source scan best-effort sau deploy để phát hiện event vừa live.

Nguồn duy nhất của playlist vẫn là:

https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u
