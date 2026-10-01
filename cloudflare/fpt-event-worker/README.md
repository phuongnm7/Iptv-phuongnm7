# NM7 FPT Event Live — Cloudflare Worker

Worker tự động tạo playlist **SỰ KIỆN FPT** từ source M3U trên GitHub và cập nhật mỗi 5 phút bằng Cloudflare Cron.

## Trạng thái kiến trúc hiện tại

Source hiện có **46 endpoint**: **38 HLS + 8 DASH**. Worker quét toàn bộ 46 endpoint trong mỗi chu kỳ 5 phút.

Bản v7 được thiết kế để chạy an toàn trên Workers Free:

- 1 request lấy source M3U.
- 1 probe chính cho mỗi endpoint.
- Tối đa 2 probe fallback cho các trường hợp 401/403 hoặc redirect.
- Tổng ngân sách do code tự giới hạn ở **49 external subrequests/invocation**, giữ 1 request dự phòng dưới giới hạn 50 của Workers Free.
- Không còn Promise.all khởi chạy toàn bộ 46 probe cùng lúc; pool tối đa 5 probe đồng thời.
- Probe manifest dùng redirect: manual để redirect không âm thầm tiêu thêm subrequest.
- Có timeout 8 giây cho từng probe.
- Nếu source tăng vượt kích thước quét an toàn, Worker **fail rõ ràng** thay vì âm thầm bỏ qua endpoint.

Cloudflare Workers Free hiện giới hạn **50 external subrequests mỗi invocation**; Workers Paid mặc định là 10.000 và có thể cấu hình cao hơn. Redirect chain cũng có thể làm tăng số subrequest.

## Mục tiêu playlist

Chỉ những stream đã xác nhận là live mới được đưa vào playlist:

- HLS: phải là #EXTM3U, không có #EXT-X-ENDLIST, không phải VOD, và có segment/variant/media sequence.
- DASH: phải là MPD hợp lệ, không phải type=static, và có tín hiệu live (dynamic, minimumUpdatePeriod, timeShiftBufferDepth, availabilityStartTime hoặc suggestedPresentationDelay) cùng cấu trúc media.
- 404/410 hoặc manifest kết thúc → loại khỏi playlist.
- HTTP 200 nhưng trả HTML/không phải M3U/MPD → ghi nhận là probe error, không coi là inactive.

## Chống playlist rỗng/stale

Worker không còn giữ nguyên toàn bộ playlist chỉ vì bất kỳ một probe nào lỗi.

Chỉ trong tình huống toàn bộ probe bị chặn bởi lỗi giới hạn subrequest thì playlist tốt trước đó mới được giữ nguyên.

Như vậy:

- lỗi một nguồn → nguồn đó không được công bố, các nguồn live khác vẫn được cập nhật;
- nguồn đã kết thúc → bị loại ở lần scan tiếp theo;
- lỗi quota toàn cục → không ghi đè playlist tốt thành playlist rỗng.

## Cron

wrangler.jsonc giữ:

    "triggers": {
      "crons": ["*/5 * * * *"]
    }

Cron Triggers chạy theo UTC.

## Endpoint

Playlist:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u

Status:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status

Manual full scan:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/scan

## Diagnostic fields mới

/status hiển thị:

- scanHealthy
- scanDegraded
- stalePlaylist
- preservedBecauseQuotaFailure
- quotaFailureDetected
- scanDurationMs
- subrequestBudget.used
- subrequestBudget.maxExternalSubrequests
- subrequestBudget.fallbackProbesUsed
- subrequestBudget.concurrency
- dashDiagnostics
- protocolStats
- tối đa 12 lỗi probe chi tiết

Header playlist:

- X-NM7-FPT-Events
- X-NM7-FPT-Version

## Cron failure reporting

scheduled() không còn nuốt exception. Sau khi ghi trạng thái lỗi vào KV, lỗi được throw lại để **Cron Past Events** phản ánh đúng invocation thất bại thay vì hiện xanh giả.

## Deploy

Từ thư mục:

    cloudflare/fpt-event-worker

Deploy:

    npx wrangler deploy --config wrangler.jsonc

Workflow GitHub Actions .github/workflows/deploy-fpt-event-worker.yml tự deploy khi có thay đổi trong Worker và kiểm tra đúng workerVersion v7 cùng ngân sách subrequest sau deploy.

## Nguồn

Worker lấy source từ:

https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u

Repo source hiện gồm các URL VIPS HLS và DASH cho SỰ KIỆN FPT, bao gồm các URL dạng su-kien-XX-4k/dash_hvc/index.mpd và event-XX-4k/....
