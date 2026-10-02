# NM7 FPT Event Watchdog

Watchdog độc lập cho GitHub Actions scanner của NM7 FPT Event Live.

## Ownership

- GitHub Actions là scanner chính.
- `nm7-fpt-event-live` là delivery Worker và không có Cron Trigger.
- `nm7-fpt-event-watchdog` là Worker duy nhất chịu trách nhiệm watchdog Cron `*/5 * * * *`.

## Watchdog policy

- Mỗi 5 phút, watchdog đọc run mới nhất của `.github/workflows/fpt-event-scan.yml`.
- Watchdog đồng thời đọc `generated/fpt-event-live.status.json` để kiểm tra độ mới của kết quả.
- Nếu run còn đang hoạt động, watchdog không dispatch trùng.
- Nếu run/kết quả đã stale quá 8 phút, hoặc output không còn hợp lệ (`candidates != 46`, `sourceOnly != true`), watchdog gọi `workflow_dispatch` trên `main`.
- Kết quả watchdog ghi log `action=noop` hoặc `action=dispatch` cùng thông tin run/scan để chẩn đoán.

## GitHub API

Worker cần secret `GITHUB_TOKEN` với quyền GitHub Actions Read and write trên `phuongnm7/Iptv-phuongnm7`. Deployment lấy giá trị từ GitHub Actions repository secret `FPT_WATCHDOG_GITHUB_TOKEN` và đồng bộ secret đó vào Worker.
GitHub REST API dùng phiên bản `2026-03-10`.

## Endpoints

- `/health`: kiểm tra cấu hình cơ bản và việc đã bind secret.
- `POST /run`: chạy một vòng watchdog thủ công; endpoint này dùng cùng logic kiểm tra và dispatch với Cron.

## Cloudflare Cron

Trigger phải nằm **chỉ** trên `nm7-fpt-event-watchdog`:

`*/5 * * * *`

`nm7-fpt-event-live` phải có `triggers.crons = []`; delivery Worker không export `scheduled()` vì không có nhiệm vụ chạy nền.

## Deployment verification

Workflow deploy watchdog kiểm tra:
- JavaScript syntax;
- `/health` với `tokenConfigured=true`;
- `POST /run` có thể đọc GitHub Actions và thực hiện `noop` hoặc `dispatch`;
- scanner status có `candidates=46` và `source_only=true`.

Không ghi token vào repository.
