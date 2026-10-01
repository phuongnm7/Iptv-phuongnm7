# NM7 FPT Event Live — Cloudflare Worker

Worker tự động tạo playlist **SỰ KIỆN FPT** từ source M3U trên GitHub và cập nhật mỗi 5 phút bằng Cloudflare Cron.

## Trạng thái kiến trúc hiện tại

Source hiện có **46 endpoint**: **38 HLS + 8 DASH**. Worker quét toàn bộ 46 endpoint trong mỗi chu kỳ 5 phút.

Bản v10 giữ kiến trúc v8/v9 an toàn để chạy an toàn trên Workers Free:

- 1 request lấy source M3U.
- 1 probe chính cho mỗi endpoint.
- Tối đa 2 probe fallback cho các trường hợp 401/403 hoặc redirect.
- Tổng ngân sách do code tự giới hạn ở **49 external subrequests/invocation**, giữ 1 request dự phòng dưới giới hạn 50 của Workers Free.
- Không còn Promise.all khởi chạy toàn bộ 46 probe cùng lúc; pool tối đa 3 probe đồng thời.
- Probe manifest dùng redirect: manual để redirect không âm thầm tiêu thêm subrequest.
- Có timeout 8 giây cho từng probe.
- Nếu source tăng vượt kích thước quét an toàn, Worker **fail rõ ràng** thay vì âm thầm bỏ qua endpoint.

Cloudflare Workers Free hiện giới hạn **50 external subrequests mỗi invocation**; Workers Paid mặc định là 10.000 và có thể cấu hình cao hơn. Redirect chain cũng có thể làm tăng số subrequest.

## Chế độ lọc live v10

Worker vẫn ưu tiên xác minh trực tiếp từ 46 endpoint. Khi FPT CDN trả HTTP 403 trên toàn bộ nguồn và việc probe từ datacenter không thể thực hiện, Worker chuyển sang **metadata-assisted current events**:

- Nguồn ưu tiên: `vhd0/Stuff/m3u/listtivi.m3u`, được cập nhật tự động theo giờ; nguồn phụ: `vuminhthanh12/vmttv`.
- Worker kiểm tra thời điểm commit gần nhất của nguồn và chỉ nhận snapshot còn mới trong tối đa 3 giờ.
- Chỉ các entry FPT Event có URL `/live/media/su-kien-XX/` hoặc `/live/media/event-XX/` và metadata ảnh sự kiện gần đây mới được nhận.
- `/fpt-event-live.m3u` vẫn giữ `X-NM7-FPT-Verified: false` trong chế độ này. Header `X-NM7-FPT-Filter: metadata-assisted-current-events` cho biết playlist đang theo dõi danh sách sự kiện hiện tại qua metadata, không phải kết quả probe CDN trực tiếp.
- Khi FPT cho phép server-side probe trở lại, Worker tự quay về clean 46-endpoint scan và chỉ khi đó `X-NM7-FPT-Verified` trở lại `true`.

Điểm này giải quyết việc playlist bị rỗng khi FPT chặn datacenter, đồng thời không quay lại lỗi cũ là lấy 5 kênh cũ rồi giả định chúng đang live.

## Mục tiêu playlist


Ở chế độ clean scan, chỉ những stream đã xác nhận là live mới được đưa vào playlist; khi FPT chặn probe server-side, metadata-assisted mode chỉ đưa các event hiện đang được nguồn cập nhật quảng bá.

- HLS: phải là #EXTM3U, không có #EXT-X-ENDLIST, không phải VOD, và có segment/variant/media sequence.
- DASH: phải là MPD hợp lệ, không phải type=static, và có tín hiệu live (dynamic, minimumUpdatePeriod, timeShiftBufferDepth, availabilityStartTime hoặc suggestedPresentationDelay) cùng cấu trúc media.
- 404/410 hoặc manifest kết thúc → loại khỏi playlist.
- HTTP 200 nhưng trả HTML/không phải M3U/MPD → ghi nhận là probe error, không coi là inactive.

## Chống stale nhưng không làm sai bộ lọc

Bản v8 không còn trộn dữ liệu fallback vào playlist live.

- Scan sạch → `/fpt-event-live.m3u` nhận đúng danh sách live hiện tại; các event đã kết thúc bị loại ngay.
- Scan lỗi một hoặc nhiều endpoint → strict playlist không được cập nhật và endpoint live chuyển sang trạng thái **unverified**, không công bố snapshot cũ như đang live.
- 403 toàn bộ upstream → Worker chuyển recovery mode để giảm áp lực lên FPT, nhưng recovery không làm kênh cũ xuất hiện trong strict playlist.
- Playlist dự phòng tách riêng, tối đa 30 phút, để có đường lui mà không làm sai endpoint live chính.

## Cron

wrangler.jsonc giữ:

    "triggers": {
      "crons": ["*/5 * * * *"]
    }

Cron Triggers chạy theo UTC.

## Endpoint

Strict live playlist:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-live.m3u

Temporary fallback playlist (30 phút):

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/fpt-event-fallback.m3u

Status:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/status

Manual full scan:

https://nm7-fpt-event-live.phuongnm7-iptv.workers.dev/scan

## Diagnostic fields mới

/status hiển thị:

- scanHealthy
- scanDegraded
- stalePlaylist
- preservedBecauseDegradedScan
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

Workflow GitHub Actions .github/workflows/deploy-fpt-event-worker.yml tự deploy khi có thay đổi trong Worker, chạy `node --check`, kiểm tra workerVersion v10, header trạng thái lọc và endpoint fallback mà không ép chạy `/scan`.

## Nguồn

### Metadata recovery sources

- `https://raw.githubusercontent.com/vhd0/Stuff/main/m3u/listtivi.m3u` — nguồn ưu tiên khi FPT server-side probe bị 403; được cập nhật định kỳ.
- `https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/main/vmttv` — nguồn dự phòng current-event metadata.


Worker lấy source từ:

https://raw.githubusercontent.com/phuongnm7/Iptv-phuongnm7/main/sources/fpt-events-source.m3u

Repo source hiện gồm các URL VIPS HLS và DASH cho SỰ KIỆN FPT, bao gồm các URL dạng su-kien-XX-4k/dash_hvc/index.mpd và event-XX-4k/....
