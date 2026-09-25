# NM7 Sports Watchdog

Watchdog bên ngoài GitHub Actions cho playlist thể thao tự động của NM7 IPTV.

## Mục đích

GitHub Actions vẫn là bộ máy chính tạo `sports-auto.m3u`. Worker này chỉ giám sát:

1. Chạy Cron Trigger mỗi 5 phút.
2. Kiểm tra run mới nhất của `.github/workflows/update-sports-auto.yml`.
3. Nếu run mới nhất được tạo trong vòng 8 phút, không làm gì.
4. Nếu workflow vẫn đang `queued`/`in_progress`/... thì không tạo thêm run.
5. Nếu không có run mới trong hơn 8 phút, gọi GitHub REST API `workflow_dispatch` để kích hoạt lại workflow trên `main`.
6. Không thay đổi logic tạo playlist, lọc trận quá 180 phút, dedupe hoặc merge playlist.

GitHub hỗ trợ REST API để liệt kê workflow runs và API `workflow_dispatch` để kích hoạt workflow. Token fine-grained chỉ cần quyền **Actions: Read and write** trên repository này.

## Thiết lập Cloudflare — 1 lần

### 1. Tạo Worker từ repo hiện tại

Trong Cloudflare:

**Workers & Pages → Create application → Import an existing Git repository**

Chọn:

- Repository: `phuongnm7/Iptv-phuongnm7`
- Root directory: `tools/cloudflare-sports-watchdog`
- Build command: để trống
- Deploy command: `npx wrangler deploy`

Cloudflare sẽ đọc `wrangler.toml` và tạo Cron Trigger `*/5 * * * *`.

### 2. Tạo GitHub token

Tạo **Fine-grained personal access token** chỉ cho repository `phuongnm7/Iptv-phuongnm7`.

Chỉ cấp:

- Repository access: **Only selected repositories** → `Iptv-phuongnm7`
- Repository permissions → **Actions: Read and write**

Không cần Contents write.

### 3. Đưa token vào Worker

Cloudflare:

**Workers & Pages → nm7-sports-watchdog → Settings → Variables and Secrets → Add**

Tạo Secret:

```
GITHUB_TOKEN
```

Dán token vào Secret rồi Deploy.

**Không đưa token vào `wrangler.toml`, source code hoặc GitHub repository.**

## Kiểm tra

Sau khi deploy:

```
https://<worker-name>.<your-subdomain>.workers.dev/health
```

phải trả về JSON tương tự:

```json
{
  "ok": true,
  "service": "nm7-sports-watchdog",
  "schedule": "*/5 * * * *",
  "stale_after_minutes": 8
}
```

Sau đó xem:

**Cloudflare → Worker → Settings → Trigger Events → View events**

và:

**GitHub → Actions → Update sports auto playlist (multi-source)**

## Cách watchdog hoạt động

Ví dụ GitHub không tạo run lúc 13:05:

```
13:05  GitHub schedule bị trễ/bỏ qua
13:10  Cloudflare watchdog kiểm tra
13:10  nếu run mới nhất > 8 phút → workflow_dispatch
13:10+ GitHub Actions chạy lại workflow
13:10+ sports-auto.m3u được cập nhật
```

Nếu GitHub vẫn đang chạy một run cũ, watchdog **không tạo run thứ hai**.

## Lưu ý

Cloudflare Cron Trigger chạy theo **UTC**; `*/5 * * * *` nghĩa là cứ 5 phút một lần, không phụ thuộc múi giờ Việt Nam.

Worker này không thay thế GitHub Actions. Nó là lớp dự phòng để giảm phụ thuộc vào lịch `schedule` của GitHub.

## Test local

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```
