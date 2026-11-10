// Cloudflare Worker cho ctv-platform-lead-identity — Module A: Lead & Identity Foundation
// Viết theo Thỏa Thuận Đích 09/11/2026 (30-projects/reborn/2026-11-09_thoa-thuan-dich-module-a-lead-identity-ctv-platform.md)
// và PSS v0.1 của Tham Mưu BA (30-projects/reborn/2026-11-09_phan-bien-gpt-nen-tang-anh-hung-marketing.md).
//
// Nguyên tắc bất biến (không được vi phạm khi sửa code):
//   - Person ≠ Identity ≠ Lead ≠ Event ≠ Attribution — không gộp "1 người = 1 lead" (phản biện GPT, D06).
//   - 4 loại sự kiện tách bạch: HOOK_SHARED ≠ LINK_CLICKED ≠ LEAD_CREATED ≠ LEAD_CONVERTED — không lấy lượt
//     chia sẻ/bấm làm lượt chuyển đổi thật.
//   - Không tự tính hay trả hoa hồng ở đây — chỉ phát sự kiện ra integration_outbox cho business tự quyết (D05).
//   - Số định danh đầy đủ (SĐT) chỉ đọc được qua /admin/leads/:id/pii có lý do, có ghi audit.
//
// Cấu hình (wrangler.toml [vars] / `wrangler secret put`), thiếu thì từ chối, không tự điền số giả:
//   CONSENT_VER            phiên bản lời đồng ý đang hiển thị trên trang
//   ALLOWED_PROGRAM_CODES  danh sách program_code được nhận, cách nhau bằng dấu phẩy (vd: "EFCARE")
//   ADMIN_TOKEN            khoá quản trị (secret) — chỉ khoá này đọc được danh sách lead và PII đầy đủ
//   ALLOWED_ORIGIN         (tuỳ chọn) tên miền được gọi API từ trình duyệt khác tên miền
//   EF_ID_SERVER_URL       địa chỉ máy chủ EF-ID thật (efc-may-chu.efcare.workers.dev) — CTV đăng nhập/đăng ký
//                          qua đây, không tự xác thực PIN (10/11/2026, xem 2026-11-10_khao-sat-as-is-efcloyalty.md).
//                          Test/dev: trỏ vào máy chủ giả lập cục bộ, KHÔNG gọi production EF-ID khi test.
//   NEXT_STEP_ORG/SLA/SUPPORT  (tuỳ chọn) nội dung màn xác nhận cho khách sau khi gửi lead — để trống thì
//                          không hiển thị lời hứa nào (không tự bịa thời hạn liên hệ).

const RE_TX = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_TYPES_PUBLIC = ['HOOK_SHARED', 'LINK_CLICKED', 'LEAD_CONVERTED', 'LEAD_UPDATED']; // LEAD_CREATED chỉ máy tự sinh

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const p = url.pathname;
      if (p === '/api/v1/leads' && request.method === 'POST') return await createLead(request, env, cors);
      if (/^\/api\/v1\/leads\/[^/]+$/.test(p) && request.method === 'GET') return await getLead(p.split('/')[4], env, cors);
      if (/^\/api\/v1\/leads\/[^/]+\/events$/.test(p) && request.method === 'GET') return await listLeadEvents(p.split('/')[4], env, cors);
      if (/^\/api\/v1\/leads\/[^/]+\/events$/.test(p) && request.method === 'POST') return await addLeadEvent(request, p.split('/')[4], env, cors);
      if (/^\/api\/v1\/leads\/[^/]+\/consent\/withdraw$/.test(p) && request.method === 'POST') return await withdrawConsent(p.split('/')[4], env, cors);
      if (p === '/api/v1/admin/leads/by-source' && request.method === 'GET') return await adminLeadsBySource(request, url, env, cors);
      if (p === '/api/v1/admin/leads' && request.method === 'GET') return await adminLeads(request, url, env, cors);
      if (/^\/api\/v1\/admin\/leads\/[^/]+\/pii$/.test(p) && request.method === 'GET') return await adminLeadPii(request, url, p.split('/')[5], env, cors);
      if (p === '/api/v1/admin/outbox' && request.method === 'GET') return await adminOutbox(request, url, env, cors);
      // Module G (P0 Share Kit) — trang CTV + quản lý quà, thêm 09/11/2026
      if (p === '/api/v1/ctv/auth/register' && request.method === 'POST') return await ctvRegister(request, env, cors);
      if (p === '/api/v1/ctv/auth/login' && request.method === 'POST') return await ctvLogin(request, env, cors);
      if (p === '/api/v1/ctv/me' && request.method === 'GET') return await ctvMe(request, env, cors);
      if (p === '/api/v1/ctv/hooks' && request.method === 'GET') return await ctvListHooks(request, env, cors);
      if (p === '/api/v1/ctv/my-leads' && request.method === 'GET') return await ctvMyLeads(request, env, cors);
      if (/^\/api\/v1\/hooks\/[^/]+$/.test(p) && request.method === 'GET') return await getHookPublic(p.split('/')[4], env, cors);
      if (p === '/api/v1/admin/hooks' && request.method === 'POST') return await adminCreateHook(request, env, cors);
      if (p === '/api/v1/admin/hooks' && request.method === 'GET') return await adminListHooks(request, env, cors);
      if (/^\/api\/v1\/admin\/hooks\/[^/]+\/archive$/.test(p) && request.method === 'POST') return await adminArchiveHook(request, p.split('/')[5], env, cors);
      if (p === '/api/v1/admin/ctv' && request.method === 'GET') return await adminListCtv(request, env, cors);
      if (/^\/api\/v1\/admin\/ctv\/[^/]+\/tier$/.test(p) && request.method === 'POST') return await adminSetCtvTier(request, p.split('/')[5], env, cors);
      if (/^\/api\/v1\/admin\/ctv\/[^/]+\/manager$/.test(p) && request.method === 'POST') return await adminSetCtvManager(request, p.split('/')[5], env, cors);
      // Module E/J (Offer & Commission) — khung 10/11/2026
      if (p === '/api/v1/admin/offers' && request.method === 'POST') return await adminCreateOffer(request, env, cors);
      if (p === '/api/v1/admin/offers' && request.method === 'GET') return await adminListOffers(request, env, cors);
      if (/^\/api\/v1\/admin\/offers\/[^/]+\/publish$/.test(p) && request.method === 'POST') return await adminPublishOffer(request, p.split('/')[5], env, cors);
      if (p === '/api/v1/admin/orders' && request.method === 'POST') return await adminCreateOrder(request, env, cors);
      if (p === '/api/v1/admin/orders' && request.method === 'GET') return await adminListOrders(request, env, cors);
      if (/^\/api\/v1\/admin\/orders\/[^/]+\/mark-paid$/.test(p) && request.method === 'POST') return await adminMarkOrderPaid(request, p.split('/')[5], env, cors);
      if (p === '/api/v1/integrations/payment-events' && request.method === 'POST') return await receivePaymentEvent(request, env, cors);
      if (p === '/api/v1/ctv/commissions' && request.method === 'GET') return await ctvCommissions(request, env, cors);
      if (p === '/api/v1/health') return json({ ok: true, service: 'ctv-platform-lead-identity' }, 200, cors);
      return json({ ok: false, ma: 'KHONG_CO_DUONG_DAN' }, 404, cors);
    } catch (e) {
      console.error('[ctv-platform-lead-identity] lỗi máy chủ', e && e.stack || e);   // không trả chi tiết lỗi ra ngoài
      return json({ ok: false, ma: 'LOI_MAY_CHU' }, 500, cors);
    }
  }
};

// ---------- Tạo Lead (idempotent theo client_tx_id; phát hiện Identity trùng, không tạo Person mới) ----------
async function createLead(request, env, cors) {
  if (!env.DB || !env.CONSENT_VER) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const allowed = programCodesAllowed(env);

  const b = await readJson(request);
  if (!b) return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors);
  const txId = String(b.client_tx_id || '');
  const programCode = String(b.program_code || '').toUpperCase();
  const identityType = b.identity && String(b.identity.type || '').toUpperCase();
  const phone = identityType === 'PHONE' ? normalizePhone(b.identity && b.identity.value) : null;

  if (!RE_TX.test(txId)) return json({ ok: false, ma: 'THIEU_MA_GIAO_DICH' }, 400, cors);
  if (!allowed.includes(programCode)) return json({ ok: false, ma: 'SAI_PROGRAM_CODE' }, 400, cors);
  if (identityType !== 'PHONE' || !phone) return json({ ok: false, ma: 'SAI_DANH_TINH' }, 400, cors); // MVP chỉ nhận SĐT
  if (b.consent !== true || b.consent_ver !== env.CONSENT_VER) return json({ ok: false, ma: 'CHUA_DONG_Y' }, 400, cors);

  const attribution = b.attribution || {};
  const referrerCode = attribution.referrer_code ? String(attribution.referrer_code).slice(0, 64) : null;
  const campaignId = attribution.campaign_id ? String(attribution.campaign_id).slice(0, 64) : null;
  const hookId = attribution.hook_id ? String(attribution.hook_id).slice(0, 64) : null;

  const daCo = await findLeadByTx(env.DB, txId);
  if (daCo) return json(leadReply(daCo, true, env), 200, cors);

  for (let lan = 0; lan < 3; lan++) {
    const identityRow = await env.DB.prepare(
      'SELECT id, person_id, status FROM identities WHERE identity_type = ? AND identity_value = ?'
    ).bind('PHONE', phone).first();
    if (identityRow && identityRow.status === 'REVOKED') {
      return json({ ok: false, ma: 'DANH_TINH_DA_THU_HOI' }, 409, cors);
    }

    const now = Date.now();
    const newPerson = !identityRow;
    const personId = identityRow ? identityRow.person_id : 'per_' + crypto.randomUUID();
    const identityId = identityRow ? identityRow.id : 'idt_' + crypto.randomUUID();
    const leadId = 'led_' + crypto.randomUUID();
    const eventId = 'evt_' + crypto.randomUUID();
    const consentId = 'con_' + crypto.randomUUID();
    const outboxId = 'obx_' + crypto.randomUUID();
    const maskedPhone = maskPhone(phone);

    // KPI mục 8: 100% lead có nguồn hoặc đánh dấu DIRECT/UNKNOWN — không để NULL ngầm hiểu.
    const attributionSource = referrerCode ? 'REFERRAL' : (campaignId || hookId) ? 'CAMPAIGN' : 'DIRECT';

    const stmts = [];
    if (newPerson) {
      stmts.push(env.DB.prepare('INSERT INTO persons (id, created_at) VALUES (?, ?)').bind(personId, now));
      stmts.push(env.DB.prepare(
        'INSERT INTO identities (id, person_id, identity_type, identity_value, identity_masked, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(identityId, personId, 'PHONE', phone, maskedPhone, 'UNVERIFIED', now));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO leads (id, person_id, program_code, status, referrer_code, campaign_id, hook_id, attribution_source,
                           first_touch_event_id, last_touch_event_id, client_tx_id, created_at, updated_at)
       VALUES (?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(leadId, personId, programCode, referrerCode, campaignId, hookId, attributionSource, eventId, eventId, txId, now, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO lead_events (id, lead_id, event_type, hook_id, referrer_code, campaign_id, payload_json, idempotency_key, occurred_at, created_at)
       VALUES (?, ?, 'LEAD_CREATED', ?, ?, ?, NULL, ?, ?, ?)`
    ).bind(eventId, leadId, hookId, referrerCode, campaignId, 'leadcreate:' + txId, now, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO consent_records (id, person_id, purpose_code, policy_version, status, capture_method, granted_at, created_at)
       VALUES (?, ?, 'LEAD_CONTACT', ?, 'GRANTED', 'WEB_FORM', ?, ?)`
    ).bind(consentId, personId, env.CONSENT_VER, now, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO integration_outbox (id, event_type, program_code, payload_json, status, created_at)
       VALUES (?, 'LEAD_CREATED', ?, ?, 'PENDING', ?)`
    ).bind(outboxId, programCode, JSON.stringify({
      event_id: eventId, lead_id: leadId, program_code: programCode,
      referrer_code: referrerCode, campaign_id: campaignId, hook_id: hookId, occurred_at: now
    }), now));

    try {
      await env.DB.batch(stmts);
      return json(leadReply({ id: leadId, program_code: programCode, status: 'NEW', referrer_code: referrerCode,
        campaign_id: campaignId, hook_id: hookId, attribution_source: attributionSource,
        identity_masked: maskedPhone, created_at: now }, false, env), 200, cors);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
      const dua = await findLeadByTx(env.DB, txId);          // hai lần gửi cùng lúc: bên kia đã ghi trước
      if (dua) return json(leadReply(dua, true, env), 200, cors);
      // UNIQUE va vào identities (hai request khác client_tx_id, cùng SĐT, chạy đồng thời): đọc lại identity, thử lại
    }
  }
  throw new Error('không tạo được lead sau 3 lần');
}

async function findLeadByTx(db, txId) {
  return db.prepare(
    `SELECT l.id, l.program_code, l.status, l.referrer_code, l.campaign_id, l.hook_id, l.attribution_source, l.created_at, i.identity_masked
     FROM leads l JOIN identities i ON i.person_id = l.person_id
     WHERE l.client_tx_id = ?`
  ).bind(txId).first();
}

// next_step: Kaizen UX #3 (phản biện GPT 10/11) — chỉ hiện đơn vị/SLA/kênh hỗ trợ khi đã cấu hình thật qua
// env, KHÔNG tự bịa thời hạn liên hệ. Thiếu cấu hình thì trả null, frontend không hiển thị lời hứa nào.
function leadReply(l, lapLai, env) {
  return {
    ok: true, lap_lai: lapLai, lead_id: l.id, program_code: l.program_code, status: l.status,
    referrer_code: l.referrer_code, campaign_id: l.campaign_id, hook_id: l.hook_id, attribution_source: l.attribution_source,
    identity_masked: l.identity_masked, created_at: l.created_at,
    next_step: env ? {
      organization: env.NEXT_STEP_ORG || null,
      expected_contact_text: env.NEXT_STEP_SLA || null,
      support_url: env.NEXT_STEP_SUPPORT || null
    } : undefined
  };
}

// ---------- Đọc Lead (công khai: không trả PII đầy đủ) ----------
async function getLead(id, env, cors) {
  const l = await env.DB.prepare(
    `SELECT l.id, l.program_code, l.status, l.referrer_code, l.campaign_id, l.hook_id, l.attribution_source, l.created_at, i.identity_masked
     FROM leads l JOIN identities i ON i.person_id = l.person_id WHERE l.id = ?`
  ).bind(id).first();
  if (!l) return json({ ok: false, ma: 'KHONG_THAY_LEAD' }, 404, cors);
  return json(leadReply(l, false, env), 200, cors);
}

// ---------- Lịch sử sự kiện của Lead (công khai) ----------
async function listLeadEvents(leadId, env, cors) {
  const lead = await env.DB.prepare('SELECT id FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return json({ ok: false, ma: 'KHONG_THAY_LEAD' }, 404, cors);
  const { results } = await env.DB.prepare(
    'SELECT event_type, hook_id, referrer_code, campaign_id, occurred_at FROM lead_events WHERE lead_id = ? ORDER BY occurred_at ASC'
  ).bind(leadId).all();
  return json({ ok: true, lead_id: leadId, events: results }, 200, cors);
}

// ---------- Ghi sự kiện mới (Idempotency-Key bắt buộc; không ghi đè lịch sử) ----------
async function addLeadEvent(request, leadId, env, cors) {
  const idemKey = request.headers.get('Idempotency-Key') || '';
  if (!RE_TX.test(idemKey)) return json({ ok: false, ma: 'THIEU_IDEMPOTENCY_KEY' }, 400, cors);
  const b = await readJson(request);
  if (!b) return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors);
  const eventType = String(b.event_type || '').toUpperCase();
  if (!EVENT_TYPES_PUBLIC.includes(eventType)) return json({ ok: false, ma: 'SAI_LOAI_SU_KIEN' }, 400, cors);

  const lead = await env.DB.prepare('SELECT id, program_code, status FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return json({ ok: false, ma: 'KHONG_THAY_LEAD' }, 404, cors);

  const daCo = await env.DB.prepare('SELECT id, event_type, occurred_at FROM lead_events WHERE idempotency_key = ?').bind(idemKey).first();
  if (daCo) return json({ ok: true, lap_lai: true, event_id: daCo.id, event_type: daCo.event_type, occurred_at: daCo.occurred_at }, 200, cors);

  const now = Date.now();
  const eventId = 'evt_' + crypto.randomUUID();
  const hookId = b.hook_id ? String(b.hook_id).slice(0, 64) : null;
  const referrerCode = b.referrer_code ? String(b.referrer_code).slice(0, 64) : null;
  const campaignId = b.campaign_id ? String(b.campaign_id).slice(0, 64) : null;
  const payloadJson = b.payload ? JSON.stringify(b.payload).slice(0, 2000) : null; // không chứa PII — trách nhiệm phía gọi API
  const newStatus = eventType === 'LEAD_CONVERTED' ? 'CONVERTED' : lead.status;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO lead_events (id, lead_id, event_type, hook_id, referrer_code, campaign_id, payload_json, idempotency_key, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, leadId, eventType, hookId, referrerCode, campaignId, payloadJson, idemKey, now, now),
    eventType === 'LEAD_CONVERTED'
      ? env.DB.prepare('UPDATE leads SET last_touch_event_id = ?, conversion_touch_event_id = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(eventId, eventId, newStatus, now, leadId)
      : env.DB.prepare('UPDATE leads SET last_touch_event_id = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(eventId, newStatus, now, leadId)
    // conversion_touch_event_id chỉ ghi khi LEAD_CONVERTED — sự kiện sau (vd LEAD_UPDATED) chỉ đổi last_touch, không đụng conversion_touch
  ];
  if (eventType === 'LEAD_CONVERTED') {
    stmts.push(env.DB.prepare(
      `INSERT INTO integration_outbox (id, event_type, program_code, payload_json, status, created_at)
       VALUES (?, 'ORDER_CONFIRMED', ?, ?, 'PENDING', ?)`
    ).bind('obx_' + crypto.randomUUID(), lead.program_code, JSON.stringify({
      event_id: eventId, lead_id: leadId, program_code: lead.program_code, occurred_at: now
    }), now));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    const dua = await env.DB.prepare('SELECT id, event_type, occurred_at FROM lead_events WHERE idempotency_key = ?').bind(idemKey).first();
    if (dua) return json({ ok: true, lap_lai: true, event_id: dua.id, event_type: dua.event_type, occurred_at: dua.occurred_at }, 200, cors);
    throw e;
  }
  return json({ ok: true, lap_lai: false, event_id: eventId, event_type: eventType, occurred_at: now }, 200, cors);
}

// ---------- Khách tự rút lại đồng ý (tự phục vụ, không cần khoá quản trị) ----------
async function withdrawConsent(leadId, env, cors) {
  const lead = await env.DB.prepare('SELECT id, person_id FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return json({ ok: false, ma: 'KHONG_THAY_LEAD' }, 404, cors);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO consent_records (id, person_id, purpose_code, policy_version, status, capture_method, withdrawn_at, created_at)
       VALUES (?, ?, 'LEAD_CONTACT', ?, 'WITHDRAWN', 'WEB_FORM', ?, ?)`
    ).bind('con_' + crypto.randomUUID(), lead.person_id, env.CONSENT_VER || 'unknown', now, now),
    env.DB.prepare("UPDATE leads SET status = 'WITHDRAWN', updated_at = ? WHERE id = ?").bind(now, leadId)
  ]);
  return json({ ok: true, lead_id: leadId, status: 'WITHDRAWN' }, 200, cors);
}

// ---------- Quản trị: danh sách Lead (phân trang con trỏ, chỉ bản che) ----------
async function adminLeads(request, url, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const limit = Math.min(Math.max(toInt(url.searchParams.get('limit')) || 50, 1), 100);
  const programCode = url.searchParams.get('program_code');
  const status = url.searchParams.get('status');
  const where = [], args = [];
  if (programCode) { where.push('l.program_code = ?'); args.push(programCode.toUpperCase()); }
  if (status) { where.push('l.status = ?'); args.push(status.toUpperCase()); }
  const cur = decodeCursor(url.searchParams.get('cursor'));
  if (cur) { where.push('(l.created_at < ? OR (l.created_at = ? AND l.id < ?))'); args.push(cur.t, cur.t, cur.id); }
  const sql = `SELECT l.id, l.program_code, l.status, l.referrer_code, l.campaign_id, l.hook_id, l.attribution_source, l.created_at,
                      (SELECT i.identity_masked FROM identities i WHERE i.person_id = l.person_id ORDER BY i.created_at ASC LIMIT 1) AS identity_masked
               FROM leads l
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY l.created_at DESC, l.id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit + 1).all();
  const rows = results.slice(0, limit);
  const last = rows[rows.length - 1];
  const next = results.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
  return json({ ok: true, rows, next_cursor: next }, 200, cors);
}

// ---------- Quản trị: Dashboard nguồn lead — gộp/đếm theo attribution_source và referrer_code (mục 7 Thỏa Thuận Đích) ----------
async function adminLeadsBySource(request, url, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const programCode = url.searchParams.get('program_code');
  const where = [], args = [];
  if (programCode) { where.push('program_code = ?'); args.push(programCode.toUpperCase()); }
  const byAttribution = await env.DB.prepare(
    `SELECT attribution_source, COUNT(*) AS so_luong, SUM(CASE WHEN status = 'CONVERTED' THEN 1 ELSE 0 END) AS da_chuyen_doi
     FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY attribution_source ORDER BY so_luong DESC`
  ).bind(...args).all();
  const whereReferrer = [...where, 'referrer_code IS NOT NULL'];
  const byReferrer = await env.DB.prepare(
    `SELECT referrer_code, COUNT(*) AS so_luong, SUM(CASE WHEN status = 'CONVERTED' THEN 1 ELSE 0 END) AS da_chuyen_doi
     FROM leads WHERE ${whereReferrer.join(' AND ')}
     GROUP BY referrer_code ORDER BY so_luong DESC LIMIT 50`
  ).bind(...args).all();
  return json({ ok: true, theo_nguon: byAttribution.results, theo_nguoi_gioi_thieu: byReferrer.results }, 200, cors);
}

// ---------- Quản trị: đọc PII đầy đủ của 1 Lead — bắt buộc lý do, luôn ghi audit ----------
async function adminLeadPii(request, url, leadId, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const reason = String(url.searchParams.get('reason') || '').trim();
  if (reason.length < 3) return json({ ok: false, ma: 'THIEU_LY_DO' }, 400, cors);

  const lead = await env.DB.prepare('SELECT id, person_id FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return json({ ok: false, ma: 'KHONG_THAY_LEAD' }, 404, cors);

  const { results: identities } = await env.DB.prepare(
    'SELECT identity_type, identity_value, status FROM identities WHERE person_id = ?'
  ).bind(lead.person_id).all();

  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO pii_access_audit (id, actor, person_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind('aud_' + crypto.randomUUID(), adminActor(request), lead.person_id, 'VIEW_FULL_IDENTITY', reason, now).run();

  return json({ ok: true, lead_id: leadId, person_id: lead.person_id, identities }, 200, cors);
}

// ---------- Quản trị: xem Integration Outbox (đối soát sự kiện gửi ra ngoài) ----------
async function adminOutbox(request, url, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const limit = Math.min(Math.max(toInt(url.searchParams.get('limit')) || 50, 1), 100);
  const status = url.searchParams.get('status');
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status.toUpperCase()); }
  const sql = `SELECT id, event_type, program_code, status, attempts, created_at, delivered_at FROM integration_outbox
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return json({ ok: true, rows: results }, 200, cors);
}

// ============================================================================================
// MODULE G (P0 Share Kit) — vai trò CTV, quản lý Quà (hooks), trang CTV đọc quà.
// 10/11/2026: đăng nhập CTV qua EF-ID thật (efc-may-chu.efcare.workers.dev) — xem mục "EF-ID" bên dưới.
// ============================================================================================

// ---------- EF-ID: gọi thẳng máy chủ EF-ID thật, đúng giao thức doPost { fn, args } -> { ok, data }/{ ok:false, error }.
// Không tự xác thực PIN ở đây — EF-ID là nguồn chuẩn duy nhất (quyết định Ong Chúa 10/11/2026).
async function efcIdCall(env, fn, args) {
  // Gọi qua Service Binding (env.EF_ID), KHÔNG qua fetch() tới URL công khai efc-may-chu.efcare.workers.dev —
  // Cloudflare trả lỗi 1042 khi một Worker tự gọi Worker khác CÙNG tài khoản qua hostname *.workers.dev
  // (xác nhận thật 10/11/2026 qua wrangler tail). Service Binding đi thẳng nội bộ Cloudflare, không qua mạng công khai.
  if (!env.EF_ID) throw new Error('CHUA_CAU_HINH_EF_ID');
  const res = await env.EF_ID.fetch('https://efc-may-chu.internal/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args })
  });
  const out = await res.json();
  if (!out || out.ok !== true) throw new EfIdError(out && out.error || 'EF_ID_LOI');
  return out.data;
}
class EfIdError extends Error {}

// ---------- CTV: đăng ký — tạo EF-ID mới qua đúng cổng chuẩn (không tự chế đăng ký riêng) ----------
async function ctvRegister(request, env, cors) {
  if (!env.DB) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const b = await readJson(request);
  const ten = b && String(b.ten || '').trim().slice(0, 60);
  const phone = b && normalizePhone(b.phone);
  const pin = b && String(b.pin || '').trim();
  const namSinh = b && toInt(b.nam_sinh);
  const dongY = !!(b && b.dong_y);
  if (!ten) return json({ ok: false, ma: 'THIEU_TEN' }, 400, cors);
  if (!phone) return json({ ok: false, ma: 'SAI_DANH_TINH' }, 400, cors);
  if (!/^\d{6}$/.test(pin)) return json({ ok: false, ma: 'SAI_PIN' }, 400, cors); // EF-ID bắt buộc đúng 6 số
  if (!namSinh) return json({ ok: false, ma: 'THIEU_NAM_SINH' }, 400, cors);
  if (!dongY) return json({ ok: false, ma: 'CHUA_DONG_Y' }, 400, cors);

  let efcData;
  try {
    efcData = await efcIdCall(env, 'idDangKy', [{ ten, sdt: phone, pin, namSinh, dongY, kenh: 'EFCLoyalty' }]);
  } catch (e) {
    if (e instanceof EfIdError) return json({ ok: false, ma: 'EF_ID_TU_CHOI', chi_tiet: e.message }, 400, cors);
    throw e;
  }
  return await upsertCtvFromEfId(env, cors, efcData.efc, efcData.phien, { ten, sdt: phone });
}

// ---------- CTV: đăng nhập — EFC-xxxxxx hoặc SĐT + PIN 6 số, xác thực thật bởi EF-ID ----------
async function ctvLogin(request, env, cors) {
  if (!env.DB) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const b = await readJson(request);
  const dinhDanh = b && String(b.dinh_danh || b.phone || '').trim();
  const pin = b && String(b.pin || '').trim();
  if (!dinhDanh || !pin) return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors);

  let efcData;
  try {
    efcData = await efcIdCall(env, 'idDangNhap', [dinhDanh, pin, 'EFCLoyalty']);
  } catch (e) {
    if (e instanceof EfIdError) return json({ ok: false, ma: 'EF_ID_TU_CHOI', chi_tiet: e.message }, 401, cors);
    throw e;
  }
  return await upsertCtvFromEfId(env, cors, efcData.efc, efcData.phien);
}

// Tạo/nạp lại hồ sơ vai trò CTV theo efc_code đã xác thực. Nếu có hồ sơ CTV cũ (trước 10/11, đăng ký bằng
// SĐT+PIN tự chế, chưa gắn efc_code) trùng đúng số điện thoại — nhận lại hồ sơ đó (giữ nguyên referrer_code/tier
// đã có, không tạo hồ sơ mới làm mất lịch sử) thay vì tạo CTV mới từ đầu.
async function upsertCtvFromEfId(env, cors, efcCode, phien, hint) {
  let toi = hint;
  if (!toi || !toi.sdt) {
    const data = await efcIdCall(env, 'idToi', [phien]);
    toi = { ten: data.toi.ten, sdt: data.toi.sdt };
  }
  const phone = normalizePhone(toi.sdt);
  const maskedPhone = phone ? maskPhone(phone) : null;
  const now = Date.now();

  let row = await env.DB.prepare('SELECT id FROM ctv_profiles WHERE efc_code = ?').bind(efcCode).first();
  if (!row && phone) {
    // Hồ sơ cũ (trước đổi sang EF-ID) chưa gắn efc_code — nhận lại theo đúng SĐT đã dùng đăng ký trước đây.
    row = await env.DB.prepare(
      `SELECT c.id FROM ctv_profiles c JOIN identities i ON i.person_id = c.person_id
       WHERE c.efc_code IS NULL AND i.identity_type = 'PHONE' AND i.identity_value = ?`
    ).bind(phone).first();
    if (row) {
      await env.DB.prepare('UPDATE ctv_profiles SET efc_code = ?, ten = ?, phone_masked = ?, updated_at = ? WHERE id = ?')
        .bind(efcCode, toi.ten || null, maskedPhone, now, row.id).run();
    }
  }
  if (!row) {
    const referrerCode = 'CTV' + randomCode(5);
    const id = 'ctv_' + crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO ctv_profiles (id, efc_code, referrer_code, ten, phone_masked, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, efcCode, referrerCode, toi.ten || null, maskedPhone, 'ACTIVE', now, now).run();
      row = { id };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
      row = await env.DB.prepare('SELECT id FROM ctv_profiles WHERE efc_code = ?').bind(efcCode).first(); // đụng độ đồng thời — đọc lại
    }
  } else {
    await env.DB.prepare('UPDATE ctv_profiles SET ten = ?, phone_masked = ?, updated_at = ? WHERE id = ?')
      .bind(toi.ten || null, maskedPhone, now, row.id).run();
  }

  const full = await env.DB.prepare('SELECT referrer_code, tier, status, is_admin FROM ctv_profiles WHERE id = ?').bind(row.id).first();
  return json({ ok: true, session_token: phien, efc_code: efcCode, referrer_code: full.referrer_code,
    tier: full.tier, status: full.status, is_admin: !!full.is_admin, ten: toi.ten || null, phone_masked: maskedPhone }, 200, cors);
}

// Xác thực phiên CTV TRỰC TIẾP qua EF-ID mỗi lần gọi (không lưu session cục bộ — tránh tạo hệ định danh song
// song, đổi lấy độ trễ gọi 1 máy chủ ngoài; MVP chấp nhận đánh đổi này). session_token = chính token "phien" EF-ID.
async function authCtvSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token) return null;
  let toi;
  try { toi = await efcIdCall(env, 'idToi', [token]); } catch (_) { return null; }
  const efcCode = toi && toi.toi && toi.toi.efc;
  if (!efcCode) return null;
  const row = await env.DB.prepare(
    'SELECT id, efc_code, referrer_code, managed_by_efc_code, status AS ctv_status, tier, created_at AS ctv_created_at, phone_masked, ten, is_admin FROM ctv_profiles WHERE efc_code = ?'
  ).bind(efcCode).first();
  if (!row || row.ctv_status !== 'ACTIVE') return null;
  return row;
}

const BAC_CTV = [
  { bac: 0, ten: 'Bán ngay', mo_ta: 'Nhận hook, chia sẻ link, bắt đầu bán ngay — không cần học trước.' },
  { bac: 1, ten: 'Xây kênh', mo_ta: 'Mở quyền tạo kênh riêng (Fanpage/TikTok/YouTube). Mở sau khi hoàn thành khoá "Xây kênh triệu view".' },
  { bac: 2, ten: 'Tạo app/Skill', mo_ta: 'Mở quyền tự tạo Skill/ứng dụng trong Xưởng AI. Mở sau khi hoàn thành khoá "Master skill/app".' },
  { bac: 3, ten: 'Truyền nhân', mo_ta: 'Vai Leader, quản lý đội, nhận thưởng quản lý theo hợp đồng. Mở sau Coaching 1-1.' }
];

// ---------- CTV: thông tin của chính mình ----------
async function ctvMe(request, env, cors) {
  const sess = await authCtvSession(request, env);
  if (!sess) return json({ ok: false, ma: 'CHUA_DANG_NHAP' }, 401, cors);
  return json({ ok: true, efc_code: sess.efc_code, referrer_code: sess.referrer_code, status: sess.ctv_status, tier: sess.tier,
    created_at: sess.ctv_created_at, ten: sess.ten, phone_masked: sess.phone_masked, bac_ctv: BAC_CTV }, 200, cors);
}

// Kaizen UX #2 (phản biện GPT 10/11): gợi ý bước tiếp theo theo trạng thái — KHÔNG đổi trạng thái lead,
// chỉ là chữ hiển thị cho CTV biết nên làm gì, giữ đúng ranh giới "CTV không tự đổi trạng thái nghiệp vụ".
const GOI_Y_THEO_TRANG_THAI = {
  NEW: 'Khách vừa để lại thông tin. Chuẩn bị nội dung giới thiệu phù hợp.',
  CONTACTABLE: 'Khách đã đủ thông tin để đội ngũ liên hệ theo quy trình.',
  QUALIFIED: 'Đang được xử lý — tiếp tục chia sẻ nội dung hữu ích nếu phù hợp.',
  NURTURING: 'Đang được xử lý — tiếp tục chia sẻ nội dung hữu ích nếu phù hợp.',
  CONVERTED: 'Khách đã được ghi nhận chuyển đổi.',
  DISQUALIFIED: 'Không tiếp tục chia sẻ lời mời cho trường hợp này.',
  WITHDRAWN: 'Không tiếp tục chia sẻ lời mời cho trường hợp này.'
};

// ---------- CTV: khách tôi đã giới thiệu (lead có referrer_code = mã của chính mình) ----------
async function ctvMyLeads(request, env, cors) {
  const sess = await authCtvSession(request, env);
  if (!sess) return json({ ok: false, ma: 'CHUA_DANG_NHAP' }, 401, cors);
  const { results } = await env.DB.prepare(
    `SELECT id, program_code, status, hook_id, created_at,
            (SELECT i.identity_masked FROM identities i WHERE i.person_id = leads.person_id ORDER BY i.created_at ASC LIMIT 1) AS identity_masked
     FROM leads WHERE referrer_code = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(sess.referrer_code).all();
  const dem = { NEW: 0, CONTACTABLE: 0, QUALIFIED: 0, NURTURING: 0, CONVERTED: 0, DISQUALIFIED: 0, WITHDRAWN: 0 };
  for (const l of results) { dem[l.status] = (dem[l.status] || 0) + 1; l.goi_y = GOI_Y_THEO_TRANG_THAI[l.status] || null; }
  return json({ ok: true, leads: results, dem_theo_trang_thai: dem }, 200, cors);
}

// ---------- CTV: danh sách quà (banner + link chia sẻ gắn sẵn ref_code của chính CTV) ----------
async function ctvListHooks(request, env, cors) {
  const sess = await authCtvSession(request, env);
  if (!sess) return json({ ok: false, ma: 'CHUA_DANG_NHAP' }, 401, cors);
  const { results } = await env.DB.prepare(
    "SELECT id, title, resource_url, banner_image_url, created_at FROM hooks WHERE status = 'ACTIVE' ORDER BY created_at DESC"
  ).all();
  return json({ ok: true, referrer_code: sess.referrer_code, hooks: results }, 200, cors);
}

// ---------- Quà: đọc công khai 1 món (để index.html hiển thị khi có ?hook=, không cần đăng nhập) ----------
async function getHookPublic(id, env, cors) {
  const h = await env.DB.prepare(
    "SELECT id, title, resource_url, banner_image_url FROM hooks WHERE id = ? AND status = 'ACTIVE'"
  ).bind(id).first();
  if (!h) return json({ ok: false, ma: 'KHONG_THAY_QUA' }, 404, cors);
  return json({ ok: true, hook: h }, 200, cors);
}

// ---------- Quản trị: tạo quà — dán link, hệ thống tự dò ảnh/tiêu đề làm banner ----------
async function adminCreateHook(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const title = b && String(b.title || '').trim().slice(0, 200);
  const resourceUrl = b && String(b.resource_url || '').trim();
  if (!title || !/^https?:\/\//.test(resourceUrl)) { await auditLog(env, actor, 'CREATE_HOOK', 'hooks', null, 'FAILED'); return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors); }

  const banner = await detectBanner(resourceUrl);
  const now = Date.now();
  const id = 'hok_' + crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO hooks (id, title, resource_url, banner_image_url, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`
  ).bind(id, title, resourceUrl, banner.banner_image_url, now).run();
  await auditLog(env, actor, 'CREATE_HOOK', 'hooks', id, 'SUCCESS');
  return json({ ok: true, id, title, resource_url: resourceUrl, banner_image_url: banner.banner_image_url,
    banner_tu_dong: !!banner.banner_image_url }, 200, cors);
}

// Dò banner từ chính link admin dán — không dùng AI tạo ảnh (ngoài phạm vi Module A/G P0).
// Link là ảnh trực tiếp -> dùng luôn. Link là trang web -> đọc thẻ og:image/og:title (tốt nhất cố gắng).
// Không dò được -> trả null, CTV page tự vẽ banner chữ từ title đã có.
async function detectBanner(resourceUrl) {
  try {
    const res = await fetch(resourceUrl, { redirect: 'follow' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('image/')) return { banner_image_url: resourceUrl };
    if (ct.startsWith('text/html')) {
      const html = (await res.text()).slice(0, 200000); // chặn trang quá lớn
      const og = (prop) => {
        const re1 = new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
        const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i');
        const m = html.match(re1) || html.match(re2);
        return m ? m[1] : null;
      };
      return { banner_image_url: og('image') };
    }
  } catch (_) { /* không dò được — để trống, không chặn tạo quà */ }
  return { banner_image_url: null };
}

// ---------- Quản trị: danh sách quà (gồm cả đã lưu kho) ----------
async function adminListHooks(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const { results } = await env.DB.prepare(
    'SELECT id, title, resource_url, banner_image_url, status, created_at FROM hooks ORDER BY created_at DESC'
  ).all();
  return json({ ok: true, rows: results }, 200, cors);
}

// ---------- Quản trị: lưu kho 1 quà (không xoá — giữ lịch sử lead đã gắn hook_id này) ----------
async function adminArchiveHook(request, id, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const r = await env.DB.prepare("UPDATE hooks SET status = 'ARCHIVED' WHERE id = ?").bind(id).run();
  if (!r.meta.changes) { await auditLog(env, actor, 'ARCHIVE_HOOK', 'hooks', id, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_QUA' }, 404, cors); }
  await auditLog(env, actor, 'ARCHIVE_HOOK', 'hooks', id, 'SUCCESS');
  return json({ ok: true, id, status: 'ARCHIVED' }, 200, cors);
}

// ---------- Quản trị: danh sách CTV (để xem bậc, nâng bậc sau khi hoàn thành đào tạo ngoài nền tảng) ----------
async function adminListCtv(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const { results } = await env.DB.prepare(
    `SELECT c.efc_code, c.referrer_code, c.managed_by_efc_code, c.tier, c.status, c.ten, c.phone_masked, c.created_at,
            (SELECT COUNT(*) FROM leads WHERE referrer_code = c.referrer_code) AS so_lead
     FROM ctv_profiles c ORDER BY c.created_at DESC`
  ).all();
  return json({ ok: true, rows: results }, 200, cors);
}

// ---------- Quản trị: nâng/hạ bậc CTV (0-3) — chỉ admin, không tự động ----------
async function adminSetCtvTier(request, referrerCode, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const tier = b && toInt(b.tier);
  if (tier === null || tier < 0 || tier > 3) return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors);
  const r = await env.DB.prepare('UPDATE ctv_profiles SET tier = ? WHERE referrer_code = ?').bind(tier, referrerCode).run();
  if (!r.meta.changes) { await auditLog(env, actor, 'SET_CTV_TIER', 'ctv_profiles', referrerCode, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_CTV' }, 404, cors); }
  await auditLog(env, actor, 'SET_CTV_TIER', 'ctv_profiles', referrerCode, 'SUCCESS');
  return json({ ok: true, referrer_code: referrerCode, tier }, 200, cors);
}

// ---------- Quản trị: gán người quản lý (hưởng thưởng quản lý nội bộ 10%) — gán tay, không suy từ referrer_code ----------
async function adminSetCtvManager(request, referrerCode, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const managerEfcCode = b && b.managed_by_efc_code ? String(b.managed_by_efc_code).trim().toUpperCase() : null; // null = gỡ gán
  const r = await env.DB.prepare('UPDATE ctv_profiles SET managed_by_efc_code = ? WHERE referrer_code = ?').bind(managerEfcCode, referrerCode).run();
  if (!r.meta.changes) { await auditLog(env, actor, 'SET_CTV_MANAGER', 'ctv_profiles', referrerCode, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_CTV' }, 404, cors); }
  await auditLog(env, actor, 'SET_CTV_MANAGER', 'ctv_profiles', referrerCode, 'SUCCESS');
  return json({ ok: true, referrer_code: referrerCode, managed_by_efc_code: managerEfcCode }, 200, cors);
}

// ============================================================================================
// MODULE E/J (Offer & Commission) — khung tối giản 10/11/2026 theo Super BA v2.0 + quyết định anh Linh
// 10/11 (20% giới thiệu trực tiếp / 10% thưởng quản lý nội bộ, EFCare là seller + nguồn xác nhận thanh toán).
// Webhook thanh toán (receivePaymentEvent) CHƯA xác thực chữ ký thật — chờ EFCare cung cấp đặc tả (DEC-WEBHOOK,
// xem 2026-11-10_khao-sat-as-is-efcloyalty.md mục 6). Đợt này: admin tự xác nhận đơn đã thu tiền (mark-paid).
// ============================================================================================

async function adminCreateOffer(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const code = b && String(b.code || '').trim().slice(0, 40);
  const name = b && String(b.name || '').trim().slice(0, 200);
  const campaignId = b && b.campaign_id ? String(b.campaign_id).slice(0, 64) : null;
  const hookId = b && b.hook_id ? String(b.hook_id).slice(0, 64) : null;
  const priceMinor = b && b.price_minor != null ? toInt(b.price_minor) : null;
  const currency = (b && b.currency ? String(b.currency) : 'VND').toUpperCase().slice(0, 8);
  if (!code || !name) { await auditLog(env, actor, 'CREATE_OFFER', 'offers', null, 'FAILED'); return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors); }
  const now = Date.now();
  const id = 'off_' + crypto.randomUUID();
  try {
    await env.DB.prepare(
      'INSERT INTO offers (id, code, name, campaign_id, hook_id, price_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, code, name, campaignId, hookId, priceMinor, currency, 'DRAFT', now, now).run();
  } catch (e) {
    if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    await auditLog(env, actor, 'CREATE_OFFER', 'offers', code, 'FAILED');
    return json({ ok: false, ma: 'TRUNG_MA' }, 409, cors);
  }
  await auditLog(env, actor, 'CREATE_OFFER', 'offers', id, 'SUCCESS');
  return json({ ok: true, id, code, name, status: 'DRAFT' }, 200, cors);
}

async function adminListOffers(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const { results } = await env.DB.prepare(
    'SELECT id, code, name, campaign_id, hook_id, price_minor, currency, status, created_at FROM offers ORDER BY created_at DESC'
  ).all();
  return json({ ok: true, rows: results }, 200, cors);
}

async function adminPublishOffer(request, id, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const r = await env.DB.prepare("UPDATE offers SET status = 'PUBLISHED', updated_at = ? WHERE id = ? AND status = 'DRAFT'").bind(Date.now(), id).run();
  if (!r.meta.changes) { await auditLog(env, actor, 'PUBLISH_OFFER', 'offers', id, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_OFFER_HOAC_SAI_TRANG_THAI' }, 404, cors); }
  await auditLog(env, actor, 'PUBLISH_OFFER', 'offers', id, 'SUCCESS');
  return json({ ok: true, id, status: 'PUBLISHED' }, 200, cors);
}

async function adminCreateOrder(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const offerId = b && String(b.offer_id || '').trim();
  const leadId = b && b.lead_id ? String(b.lead_id).trim() : null;
  const amountMinor = b && toInt(b.amount_minor);
  const currency = (b && b.currency ? String(b.currency) : 'VND').toUpperCase().slice(0, 8);
  if (!offerId || amountMinor === null || amountMinor <= 0) { await auditLog(env, actor, 'CREATE_ORDER', 'orders', null, 'FAILED'); return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors); }
  const offer = await env.DB.prepare('SELECT id FROM offers WHERE id = ?').bind(offerId).first();
  if (!offer) { await auditLog(env, actor, 'CREATE_ORDER', 'orders', offerId, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_OFFER' }, 404, cors); }
  const now = Date.now();
  const id = 'ord_' + crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO orders (id, offer_id, lead_id, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, offerId, leadId, amountMinor, currency, 'PENDING_PAYMENT', now, now).run();
  await auditLog(env, actor, 'CREATE_ORDER', 'orders', id, 'SUCCESS');
  return json({ ok: true, id, offer_id: offerId, lead_id: leadId, amount_minor: amountMinor, currency, status: 'PENDING_PAYMENT' }, 200, cors);
}

async function adminListOrders(request, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const { results } = await env.DB.prepare(
    'SELECT id, offer_id, lead_id, amount_minor, currency, status, external_payment_ref, created_at FROM orders ORDER BY created_at DESC LIMIT 200'
  ).all();
  return json({ ok: true, rows: results }, 200, cors);
}

// Đánh dấu đơn đã thu tiền (đợt này: admin tự xác nhận, chờ webhook thật từ EFCare — xem ghi chú đầu mục) và
// tính hoa hồng theo 2 policy cố định: 20% người giới thiệu trực tiếp (lead.referrer_code), 10% người quản lý
// (ctv_profiles.managed_by_efc_code của chính CTV giới thiệu — KHÔNG suy theo chuỗi giới thiệu nhiều tầng).
async function adminMarkOrderPaid(request, orderId, env, cors) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, ma: 'CHUA_CAU_HINH' }, 503, cors);
  const actor = adminActor(request);
  if (!(await isAdminAuthorized(request, env))) {
    return json({ ok: false, ma: 'SAI_KHOA' }, 401, cors);
  }
  const b = await readJson(request);
  const externalRef = b && b.external_payment_ref ? String(b.external_payment_ref).slice(0, 120) : null;

  const order = await env.DB.prepare("SELECT id, lead_id, amount_minor, currency, status FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) { await auditLog(env, actor, 'MARK_ORDER_PAID', 'orders', orderId, 'FAILED'); return json({ ok: false, ma: 'KHONG_THAY_DON' }, 404, cors); }
  if (order.status !== 'PENDING_PAYMENT') { await auditLog(env, actor, 'MARK_ORDER_PAID', 'orders', orderId, 'FAILED'); return json({ ok: false, ma: 'SAI_TRANG_THAI' }, 409, cors); }

  const now = Date.now();
  const stmts = [env.DB.prepare("UPDATE orders SET status = 'PAID', external_payment_ref = ?, updated_at = ? WHERE id = ?").bind(externalRef, now, orderId)];

  if (order.lead_id) {
    const lead = await env.DB.prepare('SELECT referrer_code FROM leads WHERE id = ?').bind(order.lead_id).first();
    const referrerCode = lead && lead.referrer_code;
    if (referrerCode) {
      const ctv = await env.DB.prepare('SELECT efc_code, managed_by_efc_code FROM ctv_profiles WHERE referrer_code = ?').bind(referrerCode).first();
      if (ctv && ctv.efc_code) {
        const direct = await env.DB.prepare("SELECT id, rate_percent FROM commission_policies WHERE code = 'DIRECT_REFERRAL' AND status = 'ACTIVE'").first();
        if (direct) {
          const amt = Math.round(order.amount_minor * direct.rate_percent / 100);
          stmts.push(env.DB.prepare(
            'INSERT INTO commission_ledger (id, order_id, policy_id, beneficiary_efc_code, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind('cml_' + crypto.randomUUID(), orderId, direct.id, ctv.efc_code, amt, order.currency, 'PAYABLE', now, now));
        }
        if (ctv.managed_by_efc_code) {
          const mgmt = await env.DB.prepare("SELECT id, rate_percent FROM commission_policies WHERE code = 'MANAGEMENT_BONUS' AND status = 'ACTIVE'").first();
          if (mgmt) {
            const amt = Math.round(order.amount_minor * mgmt.rate_percent / 100);
            stmts.push(env.DB.prepare(
              'INSERT INTO commission_ledger (id, order_id, policy_id, beneficiary_efc_code, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind('cml_' + crypto.randomUUID(), orderId, mgmt.id, ctv.managed_by_efc_code, amt, order.currency, 'PAYABLE', now, now));
          }
        }
      }
    }
  }
  await env.DB.batch(stmts);
  await auditLog(env, actor, 'MARK_ORDER_PAID', 'orders', orderId, 'SUCCESS');
  return json({ ok: true, id: orderId, status: 'PAID' }, 200, cors);
}

// Webhook thanh toán từ EFCare — CHƯA xác thực chữ ký thật, chỉ ghi nhận thô (verified=0) để không mất sự
// kiện trong lúc chờ đặc tả. KHÔNG tự chuyển trạng thái đơn hàng từ đây cho tới khi có cơ chế xác thực thật.
async function receivePaymentEvent(request, env, cors) {
  const b = await readJson(request);
  if (!b) return json({ ok: false, ma: 'SAI_DU_LIEU' }, 400, cors);
  const externalEventId = String(b.external_event_id || b.id || '').trim();
  const eventType = String(b.event_type || 'UNKNOWN').trim().slice(0, 60);
  const orderId = b.order_id ? String(b.order_id).trim() : null;
  if (!externalEventId) return json({ ok: false, ma: 'THIEU_MA_SU_KIEN' }, 400, cors);
  try {
    await env.DB.prepare(
      'INSERT INTO payment_events (id, external_event_id, order_id, event_type, raw_payload_json, verified, received_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    ).bind('pev_' + crypto.randomUUID(), externalEventId, orderId, eventType, JSON.stringify(b).slice(0, 4000), Date.now()).run();
  } catch (e) {
    if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    return json({ ok: true, lap_lai: true }, 200, cors); // đã nhận trước đó — idempotent
  }
  return json({ ok: true, da_nhan: true, da_xac_thuc: false }, 202, cors);
}

// ---------- CTV: sổ hoa hồng của chính mình ----------
async function ctvCommissions(request, env, cors) {
  const sess = await authCtvSession(request, env);
  if (!sess) return json({ ok: false, ma: 'CHUA_DANG_NHAP' }, 401, cors);
  const { results } = await env.DB.prepare(
    `SELECT cl.id, cl.amount_minor, cl.currency, cl.status, cl.created_at, cp.code AS loai_hoa_hong
     FROM commission_ledger cl JOIN commission_policies cp ON cp.id = cl.policy_id
     WHERE cl.beneficiary_efc_code = ? ORDER BY cl.created_at DESC LIMIT 200`
  ).bind(sess.efc_code).all();
  return json({ ok: true, rows: results }, 200, cors);
}

// ---------- Tiện ích ----------
// Admin vào bằng 1 trong 2 đường: (1) ADMIN_TOKEN chung (anh Hùng Marketing, chưa có EF-ID riêng), hoặc
// (2) phiên EF-ID của chính CTV có cờ is_admin=1 (anh Linh, EFC-000004, 10/11/2026 — gán tay qua D1, không
// có UI tự cấp quyền admin cho người khác). adminActor() ưu tiên đọc tên thật từ phiên EF-ID nếu có.
async function isAdminAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) return true;
  const sess = await authCtvSession(request, env);
  return !!(sess && sess.is_admin);
}
function adminActor(request) {
  return (request.headers.get('X-Admin-Actor') || 'khong_ro').slice(0, 60); // nhãn admin tự khai (giữ ADMIN_TOKEN chung, 10/11)
}
async function auditLog(env, actor, action, targetType, targetId, result) {
  try {
    await env.DB.prepare(
      'INSERT INTO admin_audit_logs (id, actor, action, target_type, target_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('aal_' + crypto.randomUUID(), actor, action, targetType, targetId, result, Date.now()).run();
  } catch (_) { /* audit không được chặn thao tác chính nếu lỗi ghi log */ }
}

function programCodesAllowed(env) {
  return String(env.ALLOWED_PROGRAM_CODES || 'EFCARE').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}
export function normalizePhone(v) {
  let s = String(v || '').replace(/[\s.\-()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length === 11) s = '0' + s.slice(2);
  return /^0[35789]\d{8}$/.test(s) ? s : null;
}
export function maskPhone(s) { return s.slice(0, 3) + '****' + s.slice(-3); }
const BANG_MA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 ký tự, bỏ I O 0 1 dễ nhầm
function randomCode(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = ''; for (const x of b) s += BANG_MA[x % 32];  // 256 chia hết cho 32: phân bố đều
  return s;
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function toInt(v) { const n = Number(v); return Number.isSafeInteger(n) ? n : null; }
async function readJson(req) { try { const o = await req.json(); return o && typeof o === 'object' ? o : null; } catch (_) { return null; } }
function encodeCursor(t, id) { return btoa(t + ':' + id).replace(/=+$/, ''); }
function decodeCursor(c) {
  if (!c) return null;
  try { const s = atob(c); const i = s.indexOf(':'); const t = toInt(s.slice(0, i)); return t === null ? null : { t, id: s.slice(i + 1) }; }
  catch (_) { return null; }
}
function corsHeaders(request, env) {
  const o = request.headers.get('Origin');
  if (!env.ALLOWED_ORIGIN || o !== env.ALLOWED_ORIGIN) return {};   // mặc định chỉ cùng tên miền
  return { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
           'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key', 'Vary': 'Origin' };
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
