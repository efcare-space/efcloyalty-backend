# Nền tảng CTV — Lead & Identity (`ctv-platform-lead-identity`)

Module A của nền tảng hỗ trợ anh Hùng Marketing — Lead & Identity Foundation. Sinh từ khuôn TechOP-OS v1.2, viết lại theo
`30-projects/reborn/2026-11-09_thoa-thuan-dich-module-a-lead-identity-ctv-platform.md` (Thỏa Thuận Đích) và
`30-projects/reborn/2026-11-09_phan-bien-gpt-nen-tang-anh-hung-marketing.md` (PSS v0.1, D01–D09).

**Lưu ý vận hành:** anh Linh đã duyệt build vượt hàng WIP=1 (09/11/2026, phá lệ quyết định `70-decisions/2026-11-09_techop-os-gop-day-chuyen-3-vai-bu05-truoc.md` lần này) trong khi BU-05 chưa qua Cổng Kiểm. Ghi lại ở đây để không ai tưởng BU-05 đã xong khi thấy mã này tồn tại.

**Trạng thái kiểm:** Ong Chúa kiểm độc lập 2 lần (09/11) — lần 1 CHƯA ĐẠT (5 điểm A–E), lần 2 ĐẠT sau khi sửa. Anh Linh đã duyệt Cổng Go-Live và **đã deploy thật**. Chi tiết: `30-projects/reborn/2026-11-09_ket-qua-kiem-doc-lap-module-a-lead-identity.md` và mục 11–14 của `30-projects/reborn/2026-11-09_thoa-thuan-dich-module-a-lead-identity-ctv-platform.md`.

**KIẾN TRÚC THẬT (09/11/2026, cập nhật muộn trong ngày) — tách mặt tiền khỏi backend:**
- **Mặt tiền công khai** (link đưa cho CTV): **https://efcare-space.github.io/qua-tang/** — repo `efcare-space/qua-tang`, GitHub Pages. KHÔNG phải thư mục `public/` trong repo này.
- **API + D1** (nơi worker này thật sự chạy): **https://ctv-platform-lead-identity.efcare.workers.dev**. `wrangler.toml` đã bỏ `[assets]`, chỉ còn phục vụ API.
- `public/` trong thư mục này **chỉ còn dùng cho `dev_server.mjs` chạy thử cục bộ** (gộp API+trang, không cần CORS khi test tay). Sửa giao diện thật → sửa ở repo `efcare-space/qua-tang`, không sửa ở đây rồi quên đồng bộ.
- CORS: `ALLOWED_ORIGIN = "https://efcare-space.github.io"` trong `wrangler.toml [vars]` — đổi mặt tiền sang domain khác thì phải sửa biến này rồi `wrangler deploy` lại.

## Nguyên tắc thiết kế (không được vi phạm khi sửa)
- Person ≠ Identity ≠ Lead ≠ Event ≠ Attribution — một người có thể nhiều Identity, nhiều Lead.
- 4 loại sự kiện tách bạch: `HOOK_SHARED` ≠ `LINK_CLICKED` ≠ `LEAD_CREATED` ≠ `LEAD_CONVERTED` — không lấy lượt chia sẻ làm lượt chuyển đổi.
- Không tự tính/trả hoa hồng ở đây — chỉ phát sự kiện ra `integration_outbox` (`LEAD_CREATED`, `ORDER_CONFIRMED`) cho business tự quyết (tách hoàn toàn khỏi FaCare Life và mọi sổ cái hoa hồng khác, quyết định D05).
- `program_code` đầu tiên: `EFCARE`. Business khác thêm sau bằng cách nối vào `ALLOWED_PROGRAM_CODES`, không sửa schema.
- Số điện thoại đầy đủ chỉ đọc được qua `/api/v1/admin/leads/:id/pii`, bắt buộc lý do, luôn ghi `pii_access_audit`.

## Kiểm
```bash
python3 test_suite.py      # cú pháp mọi tệp, schema, test worker thật trên SQLite, test Outbox với máy chủ HTTP thật
```

## Đã triển khai thật (09/11/2026) — mốc cũ, giữ lại làm lịch sử
1. ~~Ong Thợ Pháp chế rà lời đồng ý~~ — đã rà, anh Linh xác nhận "ok, mọi thứ bình thường".
2. ~~Khoá bí mật `wrangler secret put ADMIN_TOKEN`~~ — đã đặt (giá trị do anh Linh chọn, rủi ro đã cảnh báo và anh chấp nhận — xem Thỏa Thuận Đích mục 13).
3. ~~`wrangler d1 create` → `wrangler deploy`~~ — xong, `database_id` đã có trong `wrangler.toml`.
4. Landing page CTV chia sẻ dùng link GitHub Pages: `https://efcare-space.github.io/qua-tang/?ref=<referrer_code>&cmp=<campaign_id>&hook=<hook_id>` (không phải `*.workers.dev` nữa).

## Việc còn thiếu, chưa làm trong đợt này (ghi rõ để không tưởng đã xong)
- Xác minh Identity bằng OTP (identity luôn ở trạng thái `UNVERIFIED` khi tạo) — PSS gốc có nêu endpoint `verify`, chưa dựng.
- Người tiêu thụ `integration_outbox` (worker/cron gửi sự kiện sang hệ thống khác, cập nhật `status`/`delivered_at`) — bảng và API đọc đã có, phần gửi đi thật chưa viết.
- Cổng AI cá nhân (Module F) — còn chờ khảo sát UX theo D04, chưa thuộc phạm vi Module A.
- Số liệu baseline/KPI kinh doanh thật của EFCare bằng con số cụ thể — Thỏa Thuận Đích mục 9 còn để trống chữ số, dù anh Linh đã xác nhận baseline tồn tại và đúng (09/11).

## Mục 7 "dashboard nguồn lead" — trả lời câu hỏi C của Ong Chúa (09/11)
Bảng lọc từng lead trong `admin.html` KHÔNG tính là dashboard — đã bổ sung riêng `GET /api/v1/admin/leads/by-source` (đếm theo `attribution_source` và theo `referrer_code`, kèm số đã chuyển đổi) và hiển thị thành 2 bảng tổng hợp ở đầu `admin.html`, tách khỏi danh sách từng dòng.

## Đường API
| Đường | Ai gọi | Ghi chú |
|---|---|---|
| `POST /api/v1/leads` | trang khách (qua Outbox) | bắt buộc `client_tx_id`, `program_code` (phải nằm trong `ALLOWED_PROGRAM_CODES`), `identity.type=PHONE`, `consent=true`; gửi lặp trả lại lead cũ |
| `GET /api/v1/leads/:id` | trang khách | không trả PII đầy đủ |
| `GET /api/v1/leads/:id/events` | trang khách | lịch sử sự kiện, không có SĐT |
| `POST /api/v1/leads/:id/events` | Module G (Hook Hub), Module D (chuyển đổi) | bắt buộc header `Idempotency-Key`; `event_type` ∈ `HOOK_SHARED, LINK_CLICKED, LEAD_CONVERTED, LEAD_UPDATED` |
| `POST /api/v1/leads/:id/consent/withdraw` | trang khách, tự phục vụ | ghi dòng `WITHDRAWN` mới, không sửa dòng cũ; chuyển lead sang `WITHDRAWN` |
| `GET /api/v1/admin/leads` | `admin.html` | `Authorization: Bearer <ADMIN_TOKEN>`; chỉ bản che; phân trang `cursor` |
| `GET /api/v1/admin/leads/by-source` | `admin.html` | dashboard nguồn: đếm theo `attribution_source` và theo `referrer_code`, kèm số đã chuyển đổi |
| `GET /api/v1/admin/leads/:id/pii` | `admin.html` | bắt buộc `?reason=`; trả SĐT đầy đủ; luôn ghi `pii_access_audit` |
| `GET /api/v1/admin/outbox` | vận hành | xem sự kiện đã/chưa gửi ra ngoài |
