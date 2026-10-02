# NM7 FPT Event Watchdog

Watchdog độc lập cho GitHub Actions scanner của NM7 FPT Event Live, theo cùng mô hình với nm7-sports-watchdog.

- GitHub Actions là scanner chính.
- nm7-fpt-event-live là delivery Worker và không probe FPT.
- Watchdog chạy Cloudflare Cron mỗi 5 phút.
- Nếu run mới nhất của .github/workflows/fpt-event-scan.yml còn mới trong 8 phút: không làm gì.
- Nếu run đang queued/in_progress/requested/waiting/pending: không dispatch trùng.
- Nếu không có run hoặc run mới nhất quá 8 phút: gọi workflow_dispatch trên main.

Cloudflare Worker cần Secret GITHUB_TOKEN với GitHub Actions Read and write trên phuongnm7/Iptv-phuongnm7.
Không ghi token vào repository.

Health: /health
Manual safe check: POST /run
