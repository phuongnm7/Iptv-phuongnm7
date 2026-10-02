# NM7 FPT Event Live — Source-only live playlist

Worker phục vụ playlist **SỰ KIỆN FPT** dựa trên đúng các URL trong source M3U của repo.

## Source duy nhất

`https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u`

Source hiện có 46 URL duy nhất (38 HLS + 8 DASH).

Không sử dụng playlist/metadata event bên ngoài và không thay URL FPT sang hostname khác.

## Vì sao tách scanner khỏi Worker

FPT CDN đang trả HTTP 403 khi request từ IP Cloudflare/GitHub datacenter, trong khi cùng URL có thể phát được từ mạng người dùng tại Việt Nam. Nếu để Worker Cloudflare tự probe, một event đang live có thể bị hiểu nhầm là không live.

Từ v13:
- GitHub Actions chạy scanner mỗi 5 phút.
- Scanner lấy **đúng URL từ source M3U**.
- Khi đường trực tiếp bị 403, scanner tìm một HTTP transport ở Việt Nam chỉ để gửi request tới chính các URL nguồn.
- Transport không cung cấp tên kênh, lịch, metadata hay URL media mới.
- Kết quả chỉ được ghi thành playlist khi có bằng chứng manifest hiện tại.

HProxy được dùng ở đây chỉ như một registry transport công khai để tìm HTTP proxy Việt Nam còn hoạt động; dữ liệu proxy không phải nguồn playlist/event. Các proxy miễn phí vốn không ổn định, nên scanner luôn lấy danh sách mới và kiểm tra lại trước khi dùng. citeturn381799search0turn381799search5

## Lọc live

HLS:
- phải có `#EXTM3U`;
- không có `#EXT-X-ENDLIST`;
- không phải VOD;
- có segment, variant hoặc media sequence.

DASH:
- phải có MPD hợp lệ;
- không phải `type="static"`;
- có tín hiệu live và cấu trúc media.

Nếu một số URL 403 nhưng một hoặc nhiều URL khác đã xác minh live, scanner xuất bản **chỉ các URL live đã xác minh**. Nếu toàn bộ đường quét lỗi và không có bằng chứng live, scanner giữ playlist trước đó thay vì tạo danh sách rỗng giả.

## Delivery Worker

Worker production: `fpt-event-delivery-v15`.

Worker **không probe trực tiếp FPT CDN và không có Cron Trigger**. Nó:
1. lấy file `generated/fpt-event-live.m3u`;
2. kiểm tra mọi URL trong file vẫn nằm nguyên văn trong source M3U;
3. phục vụ file cho NM7/IPTV app;
4. cache KV làm đường dự phòng khi GitHub tạm thời không truy cập được.

## Cron scanner

Workflow đang chạy trong `.github/workflows/update-merged-iptv.yml`:
- job merge cũ: hàng giờ;
- job `scan-fpt-events`: mỗi 5 phút ở phút 5,10,15,...55.

## Endpoint

Playlist:

`https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u`

Status:

`https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status`

`/scan` giờ chỉ đọc trạng thái hiện tại; việc probe FPT thực tế do GitHub Actions scanner đảm nhiệm.

## Tín hiệu trạng thái

Playlist headers:
- `X-NM7-FPT-Events`
- `X-NM7-FPT-Verified`
- `X-NM7-FPT-User-Confirmed`
- `X-NM7-FPT-Filter`
- `X-NM7-FPT-Source-Only`
- `X-NM7-FPT-Version`

Generated playlist có marker:
- `#NM7-SCAN-VERIFIED: true` = scanner đã xác minh live từ source URL;
- `#NM7-SCAN-VERIFIED: user-confirmed` = tạm thời do người vận hành xác nhận URL đang live, chờ scanner thay bằng kết quả tự động.

## Cron ownership

`nm7-fpt-event-live` phải giữ `triggers.crons = []`. Lịch `*/5 * * * *` chỉ thuộc `nm7-fpt-event-watchdog` và lịch scanner `.github/workflows/fpt-event-scan.yml`.

Workflow deploy của delivery Worker có bước reconcile trực tiếp Cloudflare Workers Scripts Schedules và xác nhận sau deploy rằng danh sách schedule vẫn rỗng.
