-- Cấu trúc D1 SQLite cho ctv-platform-lead-identity (Module A — Lead & Identity Foundation)
-- Khuôn TechOP-OS v1.2, viết lại theo Thỏa Thuận Đích 09/11/2026 + PSS v0.1 (Tham Mưu BA).
-- Thời gian lưu dạng số mili-giây (INTEGER), không lệch múi giờ.
-- Nguyên tắc: Person ≠ Identity ≠ Lead ≠ Event ≠ Attribution — không gộp "1 người = 1 lead".

CREATE TABLE IF NOT EXISTS persons (
    id         TEXT PRIMARY KEY,           -- per_<uuid>
    created_at INTEGER NOT NULL
);

-- Một Person có thể có nhiều Identity (nhiều SĐT/email qua thời gian). Trùng identity_value → dùng lại person_id cũ.
CREATE TABLE IF NOT EXISTS identities (
    id              TEXT PRIMARY KEY,      -- idt_<uuid>
    person_id       TEXT NOT NULL REFERENCES persons(id),
    identity_type   TEXT NOT NULL CHECK (identity_type IN ('PHONE', 'EMAIL')),
    identity_value  TEXT NOT NULL,         -- giá trị đầy đủ. CHỈ API quản trị có lý do mới đọc được (quyết định 09/11/2026)
    identity_masked TEXT NOT NULL,         -- bản che cho mọi chỗ công khai, danh sách, log
    status          TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED', 'VERIFIED', 'REVOKED')),
    created_at      INTEGER NOT NULL,
    UNIQUE (identity_type, identity_value)
);
CREATE INDEX IF NOT EXISTS idx_identities_person ON identities(person_id);

CREATE TABLE IF NOT EXISTS campaigns (
    id           TEXT PRIMARY KEY,         -- cmp_<uuid>
    program_code TEXT NOT NULL,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at   INTEGER NOT NULL
);

-- Một Person có thể có nhiều Lead (ví dụ: lead ở EFCare, lead khác ở business sau này) — không gộp chung.
CREATE TABLE IF NOT EXISTS leads (
    id                   TEXT PRIMARY KEY, -- led_<uuid>
    person_id            TEXT NOT NULL REFERENCES persons(id),
    program_code         TEXT NOT NULL,    -- EFCARE trước (09/11/2026); business khác thêm sau, không sửa bảng
    status               TEXT NOT NULL DEFAULT 'NEW'
                         CHECK (status IN ('NEW', 'CONTACTABLE', 'QUALIFIED', 'NURTURING', 'CONVERTED', 'DISQUALIFIED', 'WITHDRAWN')),
    referrer_code        TEXT,             -- ref_code của CTV giới thiệu (nếu có) — chỉ lưu để quy nguồn, không tính hoa hồng ở đây
    campaign_id          TEXT,             -- không ép FK: chiến dịch có thể do Module C ghi nhận sau, không chặn tạo lead
    hook_id              TEXT,             -- quà/hook đã đưa khách tới (Module G)
    attribution_source   TEXT NOT NULL CHECK (attribution_source IN ('REFERRAL', 'CAMPAIGN', 'DIRECT', 'UNKNOWN')),
                                            -- KPI mục 8 Thỏa Thuận Đích: 100% lead có nguồn hoặc đánh dấu DIRECT/UNKNOWN, không để NULL ngầm hiểu
    first_touch_event_id TEXT,
    last_touch_event_id  TEXT,
    conversion_touch_event_id TEXT,        -- ghi đúng 1 lần khi LEAD_CONVERTED, KHÔNG bị sự kiện sau ghi đè (khác last_touch_event_id)
    client_tx_id         TEXT UNIQUE,      -- chống tạo lead trùng khi Outbox gửi lại
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_person            ON leads(person_id);
CREATE INDEX IF NOT EXISTS idx_leads_program_created    ON leads(program_code, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_leads_referrer           ON leads(referrer_code);

-- Sổ sự kiện chỉ ghi thêm (append-only). Tách 4 loại, không lấy lượt chia sẻ làm lượt tiếp cận thành công
-- (phản biện GPT 09/11/2026, D02/D06): HOOK_SHARED ≠ LINK_CLICKED ≠ LEAD_CREATED ≠ LEAD_CONVERTED.
CREATE TABLE IF NOT EXISTS lead_events (
    id              TEXT PRIMARY KEY,      -- evt_<uuid>
    lead_id         TEXT NOT NULL REFERENCES leads(id),
    event_type      TEXT NOT NULL CHECK (event_type IN
                     ('HOOK_SHARED', 'LINK_CLICKED', 'LEAD_CREATED', 'LEAD_CONVERTED', 'LEAD_UPDATED')),
    hook_id         TEXT,
    referrer_code   TEXT,
    campaign_id     TEXT,
    payload_json    TEXT,                  -- không ghi SĐT đầy đủ hay dữ liệu nhạy cảm vào đây
    idempotency_key TEXT NOT NULL UNIQUE,   -- chặn trùng khi client gửi lại
    occurred_at     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_events_type ON lead_events(event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS consent_records (
    id             TEXT PRIMARY KEY,       -- con_<uuid>
    person_id      TEXT NOT NULL REFERENCES persons(id),
    purpose_code   TEXT NOT NULL,          -- vd: LEAD_CONTACT
    policy_version TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('GRANTED', 'WITHDRAWN')),
    capture_method TEXT NOT NULL,          -- vd: WEB_FORM
    granted_at     INTEGER,
    withdrawn_at   INTEGER,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_person ON consent_records(person_id, purpose_code);

-- Mọi lần quản trị đọc PII đầy đủ phải ghi lại ở đây (KPI: 0 truy cập PII không phép, audit 100%).
CREATE TABLE IF NOT EXISTS pii_access_audit (
    id         TEXT PRIMARY KEY,           -- aud_<uuid>
    actor      TEXT NOT NULL,              -- nhãn người/khoá đã dùng để xem
    person_id  TEXT NOT NULL,
    action     TEXT NOT NULL,              -- vd: VIEW_FULL_IDENTITY
    reason     TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pii_audit_person ON pii_access_audit(person_id, created_at DESC);

-- Sự kiện gửi ra ngoài cho business nhận lead (chỉ truyền sự kiện, không truyền lệnh trả hoa hồng —
-- đúng kiến trúc D05 đã duyệt: tách hoàn toàn khỏi sổ cái hoa hồng của bất kỳ business nào).
CREATE TABLE IF NOT EXISTS integration_outbox (
    id              TEXT PRIMARY KEY,      -- obx_<uuid>
    event_type      TEXT NOT NULL,         -- vd: LEAD_CREATED, ORDER_CONFIRMED
    program_code    TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    created_at      INTEGER NOT NULL,
    delivered_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON integration_outbox(status, next_attempt_at);

-- ========================================================================================
-- MODULE G (P0 Share Kit) — thêm 09/11/2026 theo yêu cầu "trang CTV" + "quản lý quà" của anh Linh.
-- 10/11/2026: đổi đăng nhập CTV từ SĐT+PIN tự chế sang EF-ID chuẩn (efc-may-chu.efcare.workers.dev),
-- theo định hướng Ong Chúa — không tạo hệ định danh song song. Xem khảo sát AS-IS:
-- 30-projects/reborn/2026-11-10_khao-sat-as-is-efcloyalty.md
-- ========================================================================================

-- Hồ sơ VAI TRÒ CTV, không phải định danh — định danh gốc là EF-ID (efc_code, dạng EFC-xxxxxx).
-- ten/phone_masked chỉ là cache hiển thị, nạp lại mỗi lần đăng nhập từ EF-ID (không phải nguồn chuẩn).
CREATE TABLE IF NOT EXISTS ctv_profiles (
    id                   TEXT PRIMARY KEY,      -- ctv_<uuid>
    person_id            TEXT REFERENCES persons(id), -- CHỈ còn để nhận lại hồ sơ CTV tạo trước 10/11 (SĐT+PIN tự chế) theo
                                                  -- đúng SĐT khi họ đăng nhập EF-ID lần đầu; hồ sơ tạo mới sau 10/11 để NULL.
    efc_code             TEXT UNIQUE,            -- mã EF-ID — NULL chỉ trong khoảnh khắc giữa các bước tạo (không nên xảy ra ở code mới)
    referrer_code        TEXT NOT NULL UNIQUE,   -- mã gắn vào ?ref= khi CTV chia sẻ quà — giữ nguyên dù đổi cơ chế đăng nhập
    managed_by_efc_code  TEXT,                   -- người quản lý hưởng thưởng quản lý nội bộ 10% — gán tay (admin), KHÔNG suy từ referrer_code
    ten                  TEXT,                   -- cache hiển thị từ EF-ID
    phone_masked         TEXT,                   -- cache hiển thị từ EF-ID (SĐT đã che)
    tier                 INTEGER NOT NULL DEFAULT 0 CHECK (tier IN (0, 1, 2, 3)),
                                                  -- Lộ trình CTV 4 bậc: 0 Bán ngay · 1 Xây kênh · 2 Tạo app/Skill · 3 Truyền nhân.
                                                  -- Admin nâng bậc sau khi CTV hoàn thành đào tạo ngoài nền tảng — không tự động tính ở đây.
    status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    is_admin             INTEGER NOT NULL DEFAULT 0, -- 1 = phiên EF-ID của người này được vào trang quản trị,
                                                  -- gán tay qua D1 (không có UI tự cấp — tự cấp quyền admin là việc rủi ro cao)
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);

-- "Quà" admin dán link vào — hệ thống tự dò ảnh/tiêu đề (banner) từ chính link đó, không cần AI tạo ảnh.
CREATE TABLE IF NOT EXISTS hooks (
    id               TEXT PRIMARY KEY,       -- hok_<uuid>
    title            TEXT NOT NULL,
    resource_url     TEXT NOT NULL,          -- link món quà gốc (ảnh, video, trang) do admin dán
    banner_image_url TEXT,                   -- tự dò: ảnh trực tiếp hoặc og:image của resource_url; NULL thì CTV page tự vẽ banner chữ
    status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hooks_status ON hooks(status, created_at DESC);

-- ========================================================================================
-- MODULE E/J (Offer & Commission) — khung tối giản 10/11/2026 theo Super BA v2.0 + quyết định anh Linh:
-- giá tuỳ chiến dịch (không cố định toàn nền tảng), hoa hồng giới thiệu trực tiếp 20% + thưởng quản lý 10%,
-- EFCare là seller + nguồn xác nhận thanh toán (webhook), EFCare tự chi trả hàng tháng — nền tảng chỉ theo dõi trạng thái.
-- ========================================================================================

CREATE TABLE IF NOT EXISTS offers (
    id          TEXT PRIMARY KEY,          -- off_<uuid>
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    campaign_id TEXT,
    hook_id     TEXT,
    price_minor INTEGER,                   -- đơn vị nhỏ nhất (đồng VND); NULL = miễn phí
    currency    TEXT NOT NULL DEFAULT 'VND',
    status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'ENDED', 'ARCHIVED')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status, created_at DESC);

-- Nạp sẵn 2 chính sách cố định anh Linh đã chốt 10/11/2026 — chưa làm UI tự tạo thêm policy ở đợt này.
CREATE TABLE IF NOT EXISTS commission_policies (
    id               TEXT PRIMARY KEY,     -- cmp_pol_<uuid>
    code             TEXT NOT NULL UNIQUE, -- DIRECT_REFERRAL | MANAGEMENT_BONUS
    rate_percent     REAL NOT NULL,
    beneficiary_rule TEXT NOT NULL CHECK (beneficiary_rule IN ('REFERRER', 'MANAGER')),
                                           -- REFERRER: CTV giới thiệu trực tiếp (lead.referrer_code)
                                           -- MANAGER: người quản lý gán tay (ctv_profiles.managed_by_efc_code)
    status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
    created_at       INTEGER NOT NULL
);
INSERT OR IGNORE INTO commission_policies (id, code, rate_percent, beneficiary_rule, status, created_at)
VALUES ('cmp_pol_direct', 'DIRECT_REFERRAL', 20.0, 'REFERRER', 'ACTIVE', 0),
       ('cmp_pol_mgmt',   'MANAGEMENT_BONUS', 10.0, 'MANAGER',  'ACTIVE', 0);

CREATE TABLE IF NOT EXISTS orders (
    id                   TEXT PRIMARY KEY, -- ord_<uuid>
    offer_id             TEXT NOT NULL REFERENCES offers(id),
    lead_id              TEXT,             -- liên kết lead nếu có, để biết referrer_code quy hoa hồng
    amount_minor         INTEGER NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'VND',
    status               TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'REFUNDED', 'CANCELLED')),
    external_payment_ref TEXT,             -- mã tham chiếu phía EFCare — nguồn xác nhận thanh toán thật
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);

-- Webhook thanh toán từ EFCare — CHƯA xác thực chữ ký thật (chờ EFCare cung cấp đặc tả, xem DEC-WEBHOOK trong
-- 2026-11-10_khao-sat-as-is-efcloyalty.md mục 6). verified=0 nghĩa là mới chỉ nhận thô, chưa xác minh nguồn.
CREATE TABLE IF NOT EXISTS payment_events (
    id                 TEXT PRIMARY KEY,   -- pev_<uuid>
    external_event_id  TEXT NOT NULL UNIQUE,
    order_id           TEXT,
    event_type         TEXT NOT NULL,
    raw_payload_json    TEXT NOT NULL,
    verified           INTEGER NOT NULL DEFAULT 0,
    received_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commission_ledger (
    id                    TEXT PRIMARY KEY, -- cml_<uuid>
    order_id              TEXT NOT NULL REFERENCES orders(id),
    policy_id             TEXT NOT NULL REFERENCES commission_policies(id),
    beneficiary_efc_code  TEXT NOT NULL,
    amount_minor          INTEGER NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'VND',
    status                TEXT NOT NULL DEFAULT 'PAYABLE'
                           CHECK (status IN ('PENDING_VALIDATION', 'APPROVED', 'PAYABLE', 'PAID', 'REJECTED', 'ON_HOLD', 'REVERSED')),
    reason_code           TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commission_beneficiary ON commission_ledger(beneficiary_efc_code, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_order ON commission_ledger(order_id);

-- Admin giữ ADMIN_TOKEN chung đợt này (anh Linh chốt 10/11 — không gộp EF-ID), chỉ thêm audit theo nhãn tự khai.
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id          TEXT PRIMARY KEY,  -- aal_<uuid>
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id   TEXT,
    result      TEXT NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED')),
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
