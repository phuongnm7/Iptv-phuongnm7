# NM7 FPT Event Live — Cloudflare Worker

Worker này thay thế phần runtime tự động của GitHub Actions cho FPT Event Live.

## Kiến trúc

- 250 candidate HLS endpoints.
- 5 Cron Triggers.
- Mỗi trigger quét 50 endpoint.
- Sau mỗi 5 phút, toàn bộ 250 endpoint được quét một lần.
- Workers Free giới hạn 50 external subrequests/invocation, nên chia thành 5 batch.
- Mỗi batch ghi một KV key riêng để tránh race condition.
- Playlist được tạo động từ 5 batch KV keys.
- Không cần commit fpt-event-live.m3u liên tục vào GitHub.
- VIPS luôn trả về master index.m3u8, không xuất child AVC URL, để player tự lấy audio rendition.

## 1. Tạo KV

Cloudflare Dashboard:

1. Workers & Pages
2. KV
3. Create namespace
4. Đặt tên ví dụ: NM7_FPT_EVENT
5. Copy Namespace ID.

Sau đó thay REPLACE_WITH_YOUR_KV_NAMESPACE_ID trong wrangler.jsonc.

## 2. Deploy

Từ thư mục này:

npx wrangler deploy

Hoặc import repository vào Cloudflare Workers & Pages rồi deploy thư mục cloudflare/fpt-event-worker.

## 3. Sau khi deploy

Worker sẽ có URL dạng:

https://nm7-fpt-event-live.<your-subdomain>.workers.dev

Playlist:

https://nm7-fpt-event-live.<your-subdomain>.workers.dev/fpt-event-live.m3u

Status:

https://nm7-fpt-event-live.<your-subdomain>.workers.dev/status

## 4. Kiểm tra

Mở /status.

Khi 5 batch đã chạy ít nhất một lần:

- ready phải là true
- batchesReady phải là 5
- candidates phải là 250

Sau đó mở /fpt-event-live.m3u.

## 5. Cron

Các batch chạy lệch nhau 1 phút:

- batch 0: phút 0,5,10,...
- batch 1: phút 1,6,11,...
- batch 2: phút 2,7,12,...
- batch 3: phút 3,8,13,...
- batch 4: phút 4,9,14,...

Như vậy 250 endpoint được quét đủ trong mỗi chu kỳ 5 phút.

## 6. GitHub Actions cũ

Không tắt workflow GitHub ngay trước khi Worker được deploy và kiểm tra thành công.

Sau khi /status và playlist Worker hoạt động ổn định, có thể disable:
.github/workflows/update-fpt-event-live.yml

Workflow cũ được giữ làm phương án dự phòng trong giai đoạn chuyển đổi.

## 7. Âm thanh

Worker không chọn rendition video có bandwidth cao nhất để xuất ra playlist.

Đối với FPT VIPS, URL công bố luôn là:
.../hls_avc_v6/index.m3u8

Đây là master HLS. Việc này giữ nguyên cách sửa lỗi mất tiếng vừa thực hiện trên GitHub scanner.
