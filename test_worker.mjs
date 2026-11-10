// Test worker.js THẬT + schema.sql THẬT trên SQLite thật (node:sqlite). Chạy: node --test test_worker.mjs
// Bao đủ 10 ca nghiệm thu của Thỏa Thuận Đích Module A (mục 8).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from './worker.js';
import { D1Node } from './d1_node.mjs';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = 'khoa-thu-quan-tri';
const EF_ID = await mayChuEfId(); // máy giả lập EF-ID thật (HTTP thật) — khởi tạo TRƯỚC khi đăng ký bất kỳ test() nào
after(() => EF_ID.dong()); // đóng lại sau khi hết test — không thì server còn lắng nghe, process không thoát
const mkEnv = (extra = {}) => ({
  DB: new D1Node(join(HERE, 'schema.sql')), CONSENT_VER: 'v1', ALLOWED_PROGRAM_CODES: 'EFCARE,MULAHUB',
  ADMIN_TOKEN: ADMIN, EF_ID_SERVER_URL: EF_ID.goc, ...extra
});
const call = async (env, method, path, body, headers = {}) => {
  const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request('https://app.test' + path, init), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
const createLead = (env, tx, extra = {}) => call(env, 'POST', '/api/v1/leads', {
  client_tx_id: tx, program_code: 'EFCARE', identity: { type: 'PHONE', value: '0912 345 678' },
  consent: true, consent_ver: 'v1', attribution: { referrer_code: 'CTV001', campaign_id: 'CMP01', hook_id: 'HOOK01' }, ...extra
});
const addEvent = (env, leadId, key, body) => call(env, 'POST', `/api/v1/leads/${leadId}/events`, body, { 'Idempotency-Key': key });
const count = (env, t) => env.DB.prepare('SELECT COUNT(*) AS n FROM ' + t).first().n;

test('thiếu cấu hình (CONSENT_VER) thì từ chối, không tự điền', async () => {
  const r = await createLead(mkEnv({ CONSENT_VER: undefined }), 'tx-00000001');
  assert.equal(r.status, 503); assert.equal(r.body.ma, 'CHUA_CAU_HINH');
});

// Ca 1: Tạo Person mới thành công
test('tạo lead mới: tạo Person + Identity mới, trả bản che, lưu SĐT đầy đủ trong DB', async () => {
  const env = mkEnv();
  const r = await createLead(env, 'tx-00000002');
  assert.equal(r.status, 200);
  assert.equal(r.body.identity_masked, '091****678');
  assert.ok(!JSON.stringify(r.body).includes('0912345678'));
  assert.equal(count(env, 'persons'), 1); assert.equal(count(env, 'identities'), 1); assert.equal(count(env, 'leads'), 1);
  const idt = env.DB.prepare('SELECT identity_value, status FROM identities').first();
  assert.equal(idt.identity_value, '0912345678'); assert.equal(idt.status, 'UNVERIFIED');
});

// Ca 2: Identity trùng được phát hiện và xử lý đúng — không tạo Person mới
test('cùng SĐT, client_tx_id khác: dùng lại Person cũ, không tạo Identity trùng', async () => {
  const env = mkEnv();
  const a = await createLead(env, 'tx-00000003');
  const b = await createLead(env, 'tx-00000004');
  assert.notEqual(a.body.lead_id, b.body.lead_id);
  assert.equal(count(env, 'persons'), 1); assert.equal(count(env, 'identities'), 1); assert.equal(count(env, 'leads'), 2);
});

// Ca 3: Một Person có thể có nhiều Lead hợp lệ (tiếp ca 2 — đã chứng minh 2 lead, 1 person)
test('một Person nhiều Lead: cả hai lead cùng person_id', async () => {
  const env = mkEnv();
  await createLead(env, 'tx-00000005');
  await createLead(env, 'tx-00000006');
  const pids = env.DB.prepare('SELECT DISTINCT person_id FROM leads').all().results;
  assert.equal(pids.length, 1);
});

// Ca 9 (idempotency phần lead): Outbox gửi lại cùng client_tx_id — không tạo lead thứ hai
test('gửi lại cùng client_tx_id: trả lại lead cũ, không tạo thêm', async () => {
  const env = mkEnv();
  const a = await createLead(env, 'tx-00000007');
  const b = await createLead(env, 'tx-00000007');
  assert.equal(b.body.lead_id, a.body.lead_id); assert.equal(b.body.lap_lai, true);
  assert.equal(count(env, 'leads'), 1); assert.equal(count(env, 'persons'), 1);
});

test('chặn đầu vào sai: chưa đồng ý, sai phiên bản đồng ý, SĐT sai, program_code lạ, thiếu mã giao dịch, JSON hỏng', async () => {
  const env = mkEnv();
  assert.equal((await createLead(env, 'tx-00000008', { consent: false })).body.ma, 'CHUA_DONG_Y');
  assert.equal((await createLead(env, 'tx-00000008', { consent_ver: 'v0' })).body.ma, 'CHUA_DONG_Y');
  assert.equal((await createLead(env, 'tx-00000008', { identity: { type: 'PHONE', value: '12345' } })).body.ma, 'SAI_DANH_TINH');
  assert.equal((await createLead(env, 'tx-00000008', { program_code: 'FACARE_LIFE' })).body.ma, 'SAI_PROGRAM_CODE');
  assert.equal((await createLead(env, 'x')).body.ma, 'THIEU_MA_GIAO_DICH');
  assert.equal((await call(env, 'POST', '/api/v1/leads', '{hỏng')).status, 400);
  assert.equal(count(env, 'leads'), 0);
});

// Ca 5: Attribution được ghi nhận chính xác
test('attribution (referrer_code, campaign_id, hook_id) lưu đúng trên Lead và trên Lead Event đầu tiên', async () => {
  const env = mkEnv();
  const r = await createLead(env, 'tx-00000009');
  assert.equal(r.body.referrer_code, 'CTV001'); assert.equal(r.body.campaign_id, 'CMP01'); assert.equal(r.body.hook_id, 'HOOK01');
  const ev = env.DB.prepare("SELECT referrer_code, campaign_id, hook_id FROM lead_events WHERE event_type = 'LEAD_CREATED'").first();
  assert.deepEqual({ ...ev }, { referrer_code: 'CTV001', campaign_id: 'CMP01', hook_id: 'HOOK01' });
});

// Phản biện Ong Chúa mục B (09/11): 100% lead có nguồn hoặc đánh dấu DIRECT/UNKNOWN, không để NULL ngầm hiểu
test('attribution_source: REFERRAL khi có referrer_code, CAMPAIGN khi chỉ có campaign/hook, DIRECT khi không có gì', async () => {
  const env = mkEnv();
  const a = await createLead(env, 'tx-attr-referral-01');
  assert.equal(a.body.attribution_source, 'REFERRAL');
  const b = await createLead(env, 'tx-attr-campaign-01', { identity: { type: 'PHONE', value: '0911111111' }, attribution: { campaign_id: 'CMP02' } });
  assert.equal(b.body.attribution_source, 'CAMPAIGN');
  const c = await createLead(env, 'tx-attr-direct-01', { identity: { type: 'PHONE', value: '0922222222' }, attribution: {} });
  assert.equal(c.body.attribution_source, 'DIRECT');
  assert.ok(!['', null].includes(c.body.attribution_source));
  const row = env.DB.prepare('SELECT attribution_source FROM leads WHERE id = ?').bind(c.body.lead_id).first();
  assert.equal(row.attribution_source, 'DIRECT');
});

// Ca 6: Consent lưu đúng phiên bản và thời gian
test('consent ghi đúng phiên bản, thời điểm, phương thức', async () => {
  const env = mkEnv();
  await createLead(env, 'tx-00000010');
  const c = env.DB.prepare("SELECT policy_version, status, capture_method FROM consent_records").first();
  assert.equal(c.policy_version, 'v1'); assert.equal(c.status, 'GRANTED'); assert.equal(c.capture_method, 'WEB_FORM');
  assert.ok(env.DB.prepare('SELECT granted_at FROM consent_records').first().granted_at > 0);
});

// Ca 4 + loại sự kiện: Không ghi đè lịch sử Lead Events — tách HOOK_SHARED ≠ LINK_CLICKED ≠ LEAD_CONVERTED
test('ghi nhiều sự kiện liên tiếp: append-only, không ghi đè, đúng thứ tự thời gian', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000011')).body;
  await addEvent(env, lead.lead_id, 'ev-key-1', { event_type: 'HOOK_SHARED', hook_id: 'HOOK01' });
  await addEvent(env, lead.lead_id, 'ev-key-2', { event_type: 'LINK_CLICKED' });
  const r = await addEvent(env, lead.lead_id, 'ev-key-3', { event_type: 'LEAD_CONVERTED' });
  assert.equal(r.status, 200);
  const events = (await call(env, 'GET', `/api/v1/leads/${lead.lead_id}/events`)).body.events;
  assert.deepEqual(events.map(e => e.event_type), ['LEAD_CREATED', 'HOOK_SHARED', 'LINK_CLICKED', 'LEAD_CONVERTED']);
  assert.equal(env.DB.prepare('SELECT status FROM leads WHERE id = ?').bind(lead.lead_id).first().status, 'CONVERTED');
});

// Phản biện Ong Chúa mục A (09/11): conversion-touch riêng biệt, không bị sự kiện sau ghi đè
test('conversion_touch_event_id: ghi đúng lúc LEAD_CONVERTED, sự kiện sau (LEAD_UPDATED) chỉ đổi last_touch, không đụng conversion_touch', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-conv-touch-01')).body;
  const r1 = env.DB.prepare('SELECT first_touch_event_id, last_touch_event_id, conversion_touch_event_id FROM leads WHERE id = ?').bind(lead.lead_id).first();
  assert.equal(r1.first_touch_event_id, r1.last_touch_event_id); assert.equal(r1.conversion_touch_event_id, null);

  const conv = await addEvent(env, lead.lead_id, 'ev-conv-1', { event_type: 'LEAD_CONVERTED' });
  const r2 = env.DB.prepare('SELECT last_touch_event_id, conversion_touch_event_id FROM leads WHERE id = ?').bind(lead.lead_id).first();
  assert.equal(r2.conversion_touch_event_id, conv.body.event_id); assert.equal(r2.last_touch_event_id, conv.body.event_id);

  await addEvent(env, lead.lead_id, 'ev-conv-2', { event_type: 'LEAD_UPDATED' });
  const r3 = env.DB.prepare('SELECT last_touch_event_id, conversion_touch_event_id FROM leads WHERE id = ?').bind(lead.lead_id).first();
  assert.notEqual(r3.last_touch_event_id, conv.body.event_id);          // last_touch đổi tiếp theo sự kiện mới
  assert.equal(r3.conversion_touch_event_id, conv.body.event_id);       // conversion_touch GIỮ NGUYÊN, không bị ghi đè
});

test('sai loại sự kiện, thiếu Idempotency-Key, lead không tồn tại: từ chối', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000012')).body;
  assert.equal((await addEvent(env, lead.lead_id, 'ev-key-4', { event_type: 'LEAD_CREATED' })).body.ma, 'SAI_LOAI_SU_KIEN');
  assert.equal((await call(env, 'POST', `/api/v1/leads/${lead.lead_id}/events`, { event_type: 'HOOK_SHARED' })).body.ma, 'THIEU_IDEMPOTENCY_KEY');
  assert.equal((await addEvent(env, 'led_khong_co', 'ev-key-5', { event_type: 'HOOK_SHARED' })).status, 404);
});

test('gửi lại cùng Idempotency-Key: không tạo sự kiện thứ hai', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000013')).body;
  const a = await addEvent(env, lead.lead_id, 'ev-key-6', { event_type: 'HOOK_SHARED' });
  const b = await addEvent(env, lead.lead_id, 'ev-key-6', { event_type: 'HOOK_SHARED' });
  assert.equal(b.body.event_id, a.body.event_id); assert.equal(b.body.lap_lai, true);
  assert.equal(count(env, 'lead_events'), 2); // LEAD_CREATED + 1 HOOK_SHARED
});

// Ca 10: Outbox — LEAD_CREATED khi tạo lead, ORDER_CONFIRMED khi LEAD_CONVERTED, không phát cho sự kiện khác
test('Outbox: LEAD_CREATED lúc tạo lead, ORDER_CONFIRMED khi chuyển đổi, không phát cho HOOK_SHARED/LINK_CLICKED', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000014')).body;
  await addEvent(env, lead.lead_id, 'ev-key-7', { event_type: 'HOOK_SHARED' });
  await addEvent(env, lead.lead_id, 'ev-key-8', { event_type: 'LINK_CLICKED' });
  await addEvent(env, lead.lead_id, 'ev-key-9', { event_type: 'LEAD_CONVERTED' });
  const types = env.DB.prepare('SELECT event_type FROM integration_outbox ORDER BY created_at').all().results.map(x => x.event_type);
  assert.deepEqual(types, ['LEAD_CREATED', 'ORDER_CONFIRMED']);
});

// Phản biện Ong Chúa mục C (09/11): dashboard nguồn lead — gộp/đếm theo nguồn, không chỉ liệt kê từng dòng
test('dashboard theo nguồn: đếm đúng theo attribution_source và theo referrer_code, kể cả đã chuyển đổi', async () => {
  const env = mkEnv();
  const a = (await createLead(env, 'tx-src-1')).body; // REFERRAL, referrer CTV001
  await createLead(env, 'tx-src-2', { identity: { type: 'PHONE', value: '0933333333' } }); // REFERRAL, referrer CTV001
  await createLead(env, 'tx-src-3', { identity: { type: 'PHONE', value: '0944444444' }, attribution: {} }); // DIRECT
  await addEvent(env, a.lead_id, 'ev-src-conv', { event_type: 'LEAD_CONVERTED' });
  assert.equal((await call(env, 'GET', '/api/v1/admin/leads/by-source')).status, 401);
  const r = await call(env, 'GET', '/api/v1/admin/leads/by-source', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(r.status, 200);
  const nguon = Object.fromEntries(r.body.theo_nguon.map(x => [x.attribution_source, x]));
  assert.equal(nguon.REFERRAL.so_luong, 2); assert.equal(nguon.REFERRAL.da_chuyen_doi, 1);
  assert.equal(nguon.DIRECT.so_luong, 1); assert.equal(nguon.DIRECT.da_chuyen_doi, 0);
  const ctv001 = r.body.theo_nguoi_gioi_thieu.find(x => x.referrer_code === 'CTV001');
  assert.equal(ctv001.so_luong, 2); assert.equal(ctv001.da_chuyen_doi, 1);
});

// Ca 7: Rút lại consent tạo sự kiện tương ứng
test('rút lại đồng ý: ghi dòng WITHDRAWN mới (không sửa dòng GRANTED cũ), lead chuyển WITHDRAWN', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000015')).body;
  const r = await call(env, 'POST', `/api/v1/leads/${lead.lead_id}/consent/withdraw`);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'WITHDRAWN');
  assert.equal(count(env, 'consent_records'), 2); // GRANTED cũ + WITHDRAWN mới, không ghi đè
  assert.equal(env.DB.prepare('SELECT status FROM leads WHERE id = ?').bind(lead.lead_id).first().status, 'WITHDRAWN');
  assert.equal((await call(env, 'POST', '/api/v1/leads/led_khong_co/consent/withdraw')).status, 404);
});

// Ca 8: Người không có quyền không đọc được PII
test('danh sách quản trị: không khoá thì 401; đúng khoá chỉ thấy bản che', async () => {
  const env = mkEnv();
  await createLead(env, 'tx-00000016');
  assert.equal((await call(env, 'GET', '/api/v1/admin/leads')).status, 401);
  assert.equal((await call(env, 'GET', '/api/v1/admin/leads', undefined, { Authorization: 'Bearer sai' })).status, 401);
  const r = await call(env, 'GET', '/api/v1/admin/leads', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].identity_masked, '091****678');
  assert.ok(!JSON.stringify(r.body).includes('0912345678'));
});

test('PII đầy đủ: cần khoá quản trị + lý do, mọi lần đọc đều ghi audit', async () => {
  const env = mkEnv();
  const lead = (await createLead(env, 'tx-00000017')).body;
  assert.equal((await call(env, 'GET', `/api/v1/admin/leads/${lead.lead_id}/pii`, undefined, { Authorization: 'Bearer ' + ADMIN })).body.ma, 'THIEU_LY_DO');
  const r = await call(env, 'GET', `/api/v1/admin/leads/${lead.lead_id}/pii?reason=khach%20yeu%20cau%20xoa`, undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(r.status, 200); assert.equal(r.body.identities[0].identity_value, '0912345678');
  assert.equal(count(env, 'pii_access_audit'), 1);
  const aud = env.DB.prepare('SELECT action, reason FROM pii_access_audit').first();
  assert.equal(aud.action, 'VIEW_FULL_IDENTITY'); assert.equal(aud.reason, 'khach yeu cau xoa');
});

test('phân trang con trỏ danh sách lead: không trùng không sót', async () => {
  const env = mkEnv();
  for (let i = 0; i < 5; i++) await createLead(env, 'tx-page-' + i, { identity: { type: 'PHONE', value: '090000000' + i } });
  env.DB.db.exec('UPDATE leads SET created_at = 1000');   // ép trùng created_at: con trỏ phải dùng thêm id
  const seen = []; let cursor = null, pages = 0;
  do {
    const q = '/api/v1/admin/leads?limit=2' + (cursor ? '&cursor=' + cursor : '');
    const r = await call(env, 'GET', q, undefined, { Authorization: 'Bearer ' + ADMIN });
    r.body.rows.forEach(x => seen.push(x.id));
    cursor = r.body.next_cursor; pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3); assert.equal(seen.length, 5); assert.equal(new Set(seen).size, 5);
});

test('phân trang dùng chỉ mục, không quét bảng', () => {
  const env = mkEnv();
  const plan = env.DB.db.prepare(
    "EXPLAIN QUERY PLAN SELECT l.id FROM leads l WHERE l.program_code = ? AND (l.created_at < ? OR (l.created_at = ? AND l.id < ?)) ORDER BY l.created_at DESC, l.id DESC LIMIT 51"
  ).all('EFCARE', 1, 1, 'x').map(r => r.detail).join(' | ');
  assert.match(plan, /idx_leads_program_created/); assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test('Identity đã thu hồi: không tạo lead mới trên identity đó', async () => {
  const env = mkEnv();
  await createLead(env, 'tx-00000018');
  env.DB.db.exec("UPDATE identities SET status = 'REVOKED'");
  const r = await createLead(env, 'tx-00000019');
  assert.equal(r.status, 409); assert.equal(r.body.ma, 'DANH_TINH_DA_THU_HOI');
});


// ============================================================================================
// MODULE G (P0 Share Kit) — CTV đăng nhập qua EF-ID thật (efc-may-chu), 10/11/2026.
// Máy giả lập EF-ID dưới đây mô phỏng ĐÚNG giao thức doPost thật ({fn,args} -> {ok,data}), chạy HTTP
// thật trên cổng ngẫu nhiên (Zero-Mock) — KHÔNG gọi production EF-ID khi test, không mock hàm.
// ============================================================================================

async function mayChuEfId() {
  const members = []; // { efc, ten, sdt, pin, namSinh, sai, khoa }
  const sessions = new Map(); // token -> efc
  let seq = 0;
  const s = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let out;
    try {
      const { fn, args } = JSON.parse(raw || '{}');
      if (fn === 'idDangKy') {
        const p = (args && args[0]) || {};
        const namNay = new Date().getFullYear();
        if (!p.ten) out = { ok: false, error: 'Nhập tên của bạn.' };
        else if (!/^0\d{9}$/.test(String(p.sdt || ''))) out = { ok: false, error: 'SĐT không hợp lệ.' };
        else if (!(p.namSinh && namNay - p.namSinh >= 18)) out = { ok: false, error: 'Hiện ứng dụng dành cho người từ 18 tuổi.' };
        else if (!/^\d{6}$/.test(String(p.pin || ''))) out = { ok: false, error: 'Mã PIN gồm 6 số.' };
        else if (!p.dongY) out = { ok: false, error: 'Cần đồng ý để lưu tài khoản.' };
        else if (members.find(m => m.sdt === p.sdt)) out = { ok: false, error: 'Số điện thoại này đã có tài khoản.', daCo: true };
        else {
          seq++;
          const efc = 'EFC-' + String(seq).padStart(6, '0');
          members.push({ efc, ten: p.ten, sdt: p.sdt, pin: p.pin, namSinh: p.namSinh, sai: 0, khoa: false });
          const token = 'tok_' + efc + '_' + Math.random().toString(36).slice(2);
          sessions.set(token, efc);
          out = { ok: true, data: { phien: token, efc } };
        }
      } else if (fn === 'idDangNhap') {
        const [dinhDanh, pin] = args || [];
        const k = String(dinhDanh || '').trim().toUpperCase();
        const m = /^EFC-/.test(k) ? members.find(x => x.efc === k) : members.find(x => x.sdt === String(dinhDanh));
        if (!m) out = { ok: false, error: 'Chưa tìm thấy tài khoản với số này. Bấm Tạo tài khoản.' };
        else if (m.khoa) out = { ok: false, error: 'Tài khoản tạm khoá do nhập sai PIN nhiều lần.' };
        else if (m.pin !== pin) {
          m.sai++;
          if (m.sai >= 5) { m.khoa = true; out = { ok: false, error: 'Sai PIN 5 lần, tài khoản tạm khoá.' }; }
          else out = { ok: false, error: 'Mã PIN chưa đúng. Còn ' + (5 - m.sai) + ' lần thử.' };
        } else {
          m.sai = 0;
          const token = 'tok_' + m.efc + '_' + Math.random().toString(36).slice(2);
          sessions.set(token, m.efc);
          out = { ok: true, data: { phien: token, efc: m.efc } };
        }
      } else if (fn === 'idToi') {
        const [t] = args || [];
        const efc = sessions.get(t);
        const m = efc && members.find(x => x.efc === efc);
        out = m ? { ok: true, data: { toi: { efc: m.efc, ten: m.ten, sdt: m.sdt } } } : { ok: false, error: 'Phiên đăng nhập đã hết. Đăng nhập lại.' };
      } else {
        out = { ok: false, error: 'fn không hỗ trợ trong máy giả lập: ' + fn };
      }
    } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { goc: `http://127.0.0.1:${s.address().port}`, members, dong: () => new Promise(r => s.close(r)) };
}
let dem = 0;
async function dangKyCtv(env, phone, pin = '246810', extra = {}) {
  dem++;
  const r = await call(env, 'POST', '/api/v1/ctv/auth/register',
    { ten: 'Người thử ' + dem, phone, pin, nam_sinh: 1990, dong_y: true, ...extra });
  return r.body; // { session_token, efc_code, referrer_code, ... } hoặc { ok:false, ma, chi_tiet }
}
async function dangNhapCtv(env, phone, pin = '246810') {
  const r = await call(env, 'POST', '/api/v1/ctv/auth/login', { dinh_danh: phone, pin });
  return r.body;
}

test('CTV đăng ký mới: gọi thật EF-ID (idDangKy), tạo ctv_profiles gắn efc_code, không tự xác thực PIN ở đây', async () => {
  const env = mkEnv();
  const r = await call(env, 'POST', '/api/v1/ctv/auth/register',
    { ten: 'Chị A', phone: '0933000001', pin: '135790', nam_sinh: 1990, dong_y: true });
  assert.equal(r.status, 200);
  assert.match(r.body.efc_code, /^EFC-\d{6}$/);
  assert.match(r.body.referrer_code, /^CTV[A-HJ-NP-Z2-9]{5}$/);
  assert.ok(!JSON.stringify(r.body).includes('135790'), 'không được trả lại PIN trong response');
  assert.equal(count(env, 'ctv_profiles'), 1);
  assert.equal(count(env, 'persons'), 0, 'Module G không còn tự tạo persons/identities — đó là việc của EF-ID thật');
  const row = env.DB.prepare('SELECT efc_code, ten, phone_masked FROM ctv_profiles').first();
  assert.equal(row.efc_code, r.body.efc_code); assert.equal(row.ten, 'Chị A'); assert.equal(row.phone_masked, '093****001');
});

test('CTV đăng ký trùng SĐT: EF-ID tự từ chối (EF_ID_TU_CHOI), không tạo thêm ctv_profiles', async () => {
  const env = mkEnv();
  await dangKyCtv(env, '0933000002');
  const r = await call(env, 'POST', '/api/v1/ctv/auth/register',
    { ten: 'Khác tên', phone: '0933000002', pin: '999999', nam_sinh: 1990, dong_y: true });
  assert.equal(r.status, 400); assert.equal(r.body.ma, 'EF_ID_TU_CHOI');
  assert.equal(count(env, 'ctv_profiles'), 1);
});

test('Đăng ký thiếu trường: từ chối đúng mã lỗi TRƯỚC khi gọi EF-ID (không tốn lượt gọi ngoài vô ích)', async () => {
  const env = mkEnv();
  const full = { ten: 'X', phone: '0933000003', pin: '123456', nam_sinh: 1990, dong_y: true };
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, ten: '' })).body.ma, 'THIEU_TEN');
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, phone: '12345' })).body.ma, 'SAI_DANH_TINH');
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, pin: '123' })).body.ma, 'SAI_PIN');
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, pin: 'abcdef' })).body.ma, 'SAI_PIN');
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, nam_sinh: undefined })).body.ma, 'THIEU_NAM_SINH');
  assert.equal((await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, dong_y: false })).body.ma, 'CHUA_DONG_Y');
  // Tuổi <18 không bị chặn ở nền tảng — chuyển thẳng cho EF-ID tự quyết (đúng ranh giới: không trùng nghiệp vụ).
  const duoi18 = await call(env, 'POST', '/api/v1/ctv/auth/register', { ...full, phone: '0933000103', nam_sinh: 2015 });
  assert.equal(duoi18.body.ma, 'EF_ID_TU_CHOI'); assert.match(duoi18.body.chi_tiet, /18 tuổi/);
});

test('CTV đăng nhập đúng PIN (bằng SĐT hoặc EFC-code), xem được /ctv/me; không có phiên thì 401', async () => {
  const env = mkEnv();
  const dk = await dangKyCtv(env, '0933000004', '112233');

  const dnPhone = await dangNhapCtv(env, '0933000004', '112233');
  assert.equal(dnPhone.referrer_code, dk.referrer_code); assert.equal(dnPhone.efc_code, dk.efc_code);

  const dnEfc = await dangNhapCtv(env, dk.efc_code, '112233');
  assert.equal(dnEfc.referrer_code, dk.referrer_code); // đăng nhập lại bằng mã EFC cũng ra đúng CTV đó

  const me = await call(env, 'GET', '/api/v1/ctv/me', undefined, { Authorization: 'Bearer ' + dnPhone.session_token });
  assert.equal(me.status, 200); assert.equal(me.body.referrer_code, dk.referrer_code);
  assert.equal(me.body.efc_code, dk.efc_code); assert.equal(me.body.status, 'ACTIVE');
  assert.equal((await call(env, 'GET', '/api/v1/ctv/me')).status, 401);
  assert.equal((await call(env, 'GET', '/api/v1/ctv/me', undefined, { Authorization: 'Bearer phien_sai' })).status, 401);
});

test('CTV đăng nhập sai: chưa đăng ký / sai PIN / khoá sau 5 lần — EF-ID tự xử lý, nền tảng chỉ chuyển tiếp lỗi', async () => {
  const env = mkEnv();
  const chuaDk = await dangNhapCtv(env, '0933000005');
  assert.equal(chuaDk.ma, 'EF_ID_TU_CHOI'); assert.match(chuaDk.chi_tiet, /Chưa tìm thấy tài khoản/);

  await dangKyCtv(env, '0933000005', '555555');
  for (let i = 0; i < 4; i++) {
    const sai = await dangNhapCtv(env, '0933000005', '000000');
    assert.equal(sai.ma, 'EF_ID_TU_CHOI');
  }
  const khoa = await call(env, 'POST', '/api/v1/ctv/auth/login', { dinh_danh: '0933000005', pin: '000000' });
  assert.equal(khoa.status, 401); assert.match(khoa.body.chi_tiet, /tạm khoá/);
  const dungMaCungTamKhoa = await call(env, 'POST', '/api/v1/ctv/auth/login', { dinh_danh: '0933000005', pin: '555555' });
  assert.match(dungMaCungTamKhoa.body.chi_tiet, /tạm khoá/); // đang khoá, kể cả đúng PIN cũng không vào được
});

test('Hồ sơ CTV cũ (trước 10/11, chưa gắn efc_code) được NHẬN LẠI đúng theo SĐT khi đăng nhập EF-ID lần đầu — không mất referrer_code/tier cũ', async () => {
  const env = mkEnv();
  const now = Date.now();
  // Hồ sơ cũ còn giữ SĐT trong identities (cơ chế trước đổi EF-ID) để nền tảng nhận lại đúng người.
  env.DB.prepare('INSERT INTO persons (id, created_at) VALUES (?, ?)').bind('per_cu_01', now).run();
  env.DB.prepare(
    "INSERT INTO identities (id, person_id, identity_type, identity_value, identity_masked, status, created_at) VALUES (?, ?, 'PHONE', ?, ?, 'VERIFIED', ?)"
  ).bind('idt_cu_01', 'per_cu_01', '0976543210', '097****210', now).run();
  env.DB.prepare(
    'INSERT INTO ctv_profiles (id, person_id, efc_code, referrer_code, tier, status, created_at, updated_at) VALUES (?, ?, NULL, ?, 2, ?, ?, ?)'
  ).bind('ctv_cu_01', 'per_cu_01', 'CTVCUDI1', 'ACTIVE', now, now).run();

  const dk = await dangKyCtv(env, '0976543210', '246810');
  assert.equal(dk.referrer_code, 'CTVCUDI1', 'phải nhận lại referrer_code cũ, không sinh mã mới');
  assert.equal(dk.tier, 2, 'phải giữ nguyên bậc cũ');
  assert.equal(count(env, 'ctv_profiles'), 1, 'không tạo thêm hồ sơ CTV thứ hai cho cùng người');
  const row = env.DB.prepare('SELECT efc_code FROM ctv_profiles WHERE referrer_code = ?').bind('CTVCUDI1').first();
  assert.match(row.efc_code, /^EFC-\d{6}$/);
});

// --- Quà (hooks): máy chủ HTTP thật phục vụ 1 ảnh và 1 trang có og:image, để kiểm detectBanner thật ---
async function mayChuQua() {
  const s = http.createServer((req, res) => {
    if (req.url === '/anh.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end('anh-gia-lap'); }
    if (req.url === '/trang.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head><meta property="og:image" content="https://vi.du/banner-that.jpg"></head></html>');
    }
    if (req.url === '/khong-og.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>không có og:image</body></html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const goc = `http://127.0.0.1:${s.address().port}`;
  return { goc, dong: () => new Promise(r => s.close(r)) };
}

test('Admin tạo quà qua http thật: link ảnh -> banner = chính link; trang có og:image -> banner = og:image; trang không có -> banner null', async () => {
  const env = mkEnv(); const sv = await mayChuQua();
  const anh = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Ảnh mẫu', resource_url: sv.goc + '/anh.jpg' }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(anh.status, 200); assert.equal(anh.body.banner_image_url, sv.goc + '/anh.jpg'); assert.equal(anh.body.banner_tu_dong, true);

  const trang = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Trang có OG', resource_url: sv.goc + '/trang.html' }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(trang.body.banner_image_url, 'https://vi.du/banner-that.jpg');

  const khongOg = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Trang không OG', resource_url: sv.goc + '/khong-og.html' }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(khongOg.body.banner_image_url, null); assert.equal(khongOg.body.banner_tu_dong, false);

  await sv.dong();
});

test('Quà: thiếu tiêu đề/link sai, không có khoá admin: từ chối đúng', async () => {
  const env = mkEnv();
  assert.equal((await call(env, 'POST', '/api/v1/admin/hooks', { title: '', resource_url: 'https://x.y' }, { Authorization: 'Bearer ' + ADMIN })).body.ma, 'SAI_DU_LIEU');
  assert.equal((await call(env, 'POST', '/api/v1/admin/hooks', { title: 'X', resource_url: 'ftp://x.y' }, { Authorization: 'Bearer ' + ADMIN })).body.ma, 'SAI_DU_LIEU');
  assert.equal((await call(env, 'POST', '/api/v1/admin/hooks', { title: 'X', resource_url: 'https://x.y' })).status, 401);
});

test('CTV xem danh sách quà: chỉ thấy ACTIVE, có referrer_code của chính mình; không đăng nhập thì 401', async () => {
  const env = mkEnv(); const sv = await mayChuQua();
  const q1 = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Quà 1', resource_url: sv.goc + '/anh.jpg' }, { Authorization: 'Bearer ' + ADMIN });
  const q2 = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Quà 2', resource_url: sv.goc + '/khong-og.html' }, { Authorization: 'Bearer ' + ADMIN });
  await call(env, 'POST', '/api/v1/admin/hooks/' + q2.body.id + '/archive', undefined, { Authorization: 'Bearer ' + ADMIN });
  await sv.dong();

  assert.equal((await call(env, 'GET', '/api/v1/ctv/hooks')).status, 401);
  const ctv = await dangKyCtv(env, '0933000006');
  const r = await call(env, 'GET', '/api/v1/ctv/hooks', undefined, { Authorization: 'Bearer ' + ctv.session_token });
  assert.equal(r.status, 200); assert.equal(r.body.referrer_code, ctv.referrer_code);
  assert.deepEqual(r.body.hooks.map(h => h.title), ['Quà 1']); // Quà 2 đã lưu kho, không hiện

  const cong_khai = await call(env, 'GET', '/api/v1/hooks/' + q1.body.id);
  assert.equal(cong_khai.status, 200); assert.equal(cong_khai.body.hook.title, 'Quà 1');
  assert.equal((await call(env, 'GET', '/api/v1/hooks/khong_co')).status, 404);
});

test('Admin danh sách quà: thấy cả ACTIVE lẫn ARCHIVED; mỗi thao tác ghi admin_audit_logs', async () => {
  const env = mkEnv(); const sv = await mayChuQua();
  const q = await call(env, 'POST', '/api/v1/admin/hooks', { title: 'Quà A', resource_url: sv.goc + '/anh.jpg' }, { Authorization: 'Bearer ' + ADMIN });
  await call(env, 'POST', '/api/v1/admin/hooks/' + q.body.id + '/archive', undefined, { Authorization: 'Bearer ' + ADMIN });
  await sv.dong();
  const r = await call(env, 'GET', '/api/v1/admin/hooks', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(r.body.rows.length, 1); assert.equal(r.body.rows[0].status, 'ARCHIVED');
  assert.equal((await call(env, 'POST', '/api/v1/admin/hooks/khong_co/archive', undefined, { Authorization: 'Bearer ' + ADMIN })).status, 404);
  assert.equal(count(env, 'admin_audit_logs'), 3); // CREATE_HOOK + ARCHIVE_HOOK thành công + ARCHIVE_HOOK lỗi (khong_co, FAILED)
});

// ============================================================================================
// Trang CTV kiểu FaCare Life — tab Khách của tôi, Lộ trình (bậc), Thu nhập (chỉ đếm, KHÔNG có tiền). 10/11/2026.
// ============================================================================================

test('ctv/me trả đúng bậc mặc định 0 và 4 bậc lộ trình, không đổi khi chưa có admin nâng bậc', async () => {
  const env = mkEnv();
  const ctv = await dangKyCtv(env, '0944000001');
  const me = await call(env, 'GET', '/api/v1/ctv/me', undefined, { Authorization: 'Bearer ' + ctv.session_token });
  assert.equal(me.body.tier, 0);
  assert.equal(me.body.bac_ctv.length, 4);
  assert.deepEqual(me.body.bac_ctv.map(b => b.bac), [0, 1, 2, 3]);
});

test('Khách của tôi: chỉ thấy lead có referrer_code = chính mình, đếm đúng theo trạng thái, có gợi ý bước tiếp theo, không lộ SĐT đầy đủ', async () => {
  const env = mkEnv();
  const ctv = await dangKyCtv(env, '0944000002');
  await createLead(env, 'tx-myleads-01', { identity: { type: 'PHONE', value: '0955000001' },
    attribution: { referrer_code: ctv.referrer_code } });
  const b = await createLead(env, 'tx-myleads-02', { identity: { type: 'PHONE', value: '0955000002' },
    attribution: { referrer_code: ctv.referrer_code } });
  await addEvent(env, b.body.lead_id, 'ev-myleads-conv', { event_type: 'LEAD_CONVERTED' });
  await createLead(env, 'tx-myleads-03', { identity: { type: 'PHONE', value: '0955000003' },
    attribution: { referrer_code: 'CTVKHAC1' } }); // của CTV khác — không được thấy

  assert.equal((await call(env, 'GET', '/api/v1/ctv/my-leads')).status, 401);
  const r = await call(env, 'GET', '/api/v1/ctv/my-leads', undefined, { Authorization: 'Bearer ' + ctv.session_token });
  assert.equal(r.status, 200); assert.equal(r.body.leads.length, 2);
  assert.equal(r.body.dem_theo_trang_thai.NEW, 1); assert.equal(r.body.dem_theo_trang_thai.CONVERTED, 1);
  assert.ok(r.body.leads.every(l => !JSON.stringify(l).includes('0955000001') && l.identity_masked.includes('****')));
  const newLead = r.body.leads.find(l => l.status === 'NEW');
  assert.match(newLead.goi_y, /Khách vừa để lại thông tin/);
  const convLead = r.body.leads.find(l => l.status === 'CONVERTED');
  assert.match(convLead.goi_y, /ghi nhận chuyển đổi/);
});

test('Admin: danh sách CTV thấy đúng bậc + số lead; nâng bậc chỉ admin làm được, số bậc ngoài 0-3 bị từ chối', async () => {
  const env = mkEnv();
  const ctv = await dangKyCtv(env, '0944000003');
  assert.equal((await call(env, 'GET', '/api/v1/admin/ctv')).status, 401);
  const ds = await call(env, 'GET', '/api/v1/admin/ctv', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(ds.body.rows[0].referrer_code, ctv.referrer_code); assert.equal(ds.body.rows[0].tier, 0);
  assert.equal(ds.body.rows[0].efc_code, ctv.efc_code);

  assert.equal((await call(env, 'POST', '/api/v1/admin/ctv/' + ctv.referrer_code + '/tier', { tier: 1 })).status, 401); // thiếu khoá
  const nang = await call(env, 'POST', '/api/v1/admin/ctv/' + ctv.referrer_code + '/tier', { tier: 1 }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(nang.status, 200); assert.equal(nang.body.tier, 1);
  const me = await call(env, 'GET', '/api/v1/ctv/me', undefined, { Authorization: 'Bearer ' + ctv.session_token });
  assert.equal(me.body.tier, 1); // phiên EF-ID đọc lại DB mỗi lần, thấy bậc mới ngay

  assert.equal((await call(env, 'POST', '/api/v1/admin/ctv/' + ctv.referrer_code + '/tier', { tier: 9 }, { Authorization: 'Bearer ' + ADMIN })).body.ma, 'SAI_DU_LIEU');
  assert.equal((await call(env, 'POST', '/api/v1/admin/ctv/khong_co/tier', { tier: 1 }, { Authorization: 'Bearer ' + ADMIN })).status, 404);
});

// ============================================================================================
// MODULE E/J (Offer & Commission) — khung 10/11/2026: 20% giới thiệu trực tiếp, 10% thưởng quản lý nội bộ
// (gán tay, không suy từ chuỗi giới thiệu), EFCare xác nhận thanh toán (đợt này: admin tự mark-paid).
// ============================================================================================

test('Admin gán người quản lý CTV (managed_by) — gán tay, không suy từ referrer_code; gỡ gán bằng null', async () => {
  const env = mkEnv();
  const nhanVien = await dangKyCtv(env, '0966000001');
  const quanLy = await dangKyCtv(env, '0966000002');

  const gan = await call(env, 'POST', '/api/v1/admin/ctv/' + nhanVien.referrer_code + '/manager',
    { managed_by_efc_code: quanLy.efc_code }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(gan.status, 200); assert.equal(gan.body.managed_by_efc_code, quanLy.efc_code);
  const row = env.DB.prepare('SELECT managed_by_efc_code FROM ctv_profiles WHERE referrer_code = ?').bind(nhanVien.referrer_code).first();
  assert.equal(row.managed_by_efc_code, quanLy.efc_code);

  const go = await call(env, 'POST', '/api/v1/admin/ctv/' + nhanVien.referrer_code + '/manager',
    { managed_by_efc_code: null }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(go.body.managed_by_efc_code, null);
});

test('Offer: admin tạo DRAFT, publish mới hiện PUBLISHED; publish lần 2 từ chối (sai trạng thái)', async () => {
  const env = mkEnv();
  const o = await call(env, 'POST', '/api/v1/admin/offers',
    { code: 'KHOA-A', name: 'Khoá học A', price_minor: 500000 }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(o.status, 200); assert.equal(o.body.status, 'DRAFT');
  const pub = await call(env, 'POST', '/api/v1/admin/offers/' + o.body.id + '/publish', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(pub.body.status, 'PUBLISHED');
  const pub2 = await call(env, 'POST', '/api/v1/admin/offers/' + o.body.id + '/publish', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(pub2.status, 404); // đã PUBLISHED, không publish lại được
  const trung = await call(env, 'POST', '/api/v1/admin/offers', { code: 'KHOA-A', name: 'Trùng mã' }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(trung.status, 409); assert.equal(trung.body.ma, 'TRUNG_MA');
});

test('Order mark-paid: tính đúng 20% cho người giới thiệu trực tiếp + 10% cho người quản lý; không có quản lý thì chỉ 1 dòng hoa hồng', async () => {
  const env = mkEnv();
  const ctv = await dangKyCtv(env, '0966000010');
  const quanLy = await dangKyCtv(env, '0966000011');
  await call(env, 'POST', '/api/v1/admin/ctv/' + ctv.referrer_code + '/manager',
    { managed_by_efc_code: quanLy.efc_code }, { Authorization: 'Bearer ' + ADMIN });

  const offer = await call(env, 'POST', '/api/v1/admin/offers', { code: 'GOI-X', name: 'Gói X' }, { Authorization: 'Bearer ' + ADMIN });
  const lead = await createLead(env, 'tx-order-01', { identity: { type: 'PHONE', value: '0977000001' },
    attribution: { referrer_code: ctv.referrer_code } });

  const order = await call(env, 'POST', '/api/v1/admin/orders',
    { offer_id: offer.body.id, lead_id: lead.body.lead_id, amount_minor: 1000000 }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(order.status, 200); assert.equal(order.body.status, 'PENDING_PAYMENT');

  const paid = await call(env, 'POST', '/api/v1/admin/orders/' + order.body.id + '/mark-paid',
    { external_payment_ref: 'EFCARE-REF-001' }, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(paid.status, 200); assert.equal(paid.body.status, 'PAID');

  const cmlCtv = await call(env, 'GET', '/api/v1/ctv/commissions', undefined, { Authorization: 'Bearer ' + ctv.session_token });
  assert.equal(cmlCtv.body.rows.length, 1);
  assert.equal(cmlCtv.body.rows[0].amount_minor, 200000); // 20% của 1.000.000
  assert.equal(cmlCtv.body.rows[0].loai_hoa_hong, 'DIRECT_REFERRAL');
  assert.equal(cmlCtv.body.rows[0].status, 'PAYABLE');

  const cmlQuanLy = await call(env, 'GET', '/api/v1/ctv/commissions', undefined, { Authorization: 'Bearer ' + quanLy.session_token });
  assert.equal(cmlQuanLy.body.rows.length, 1);
  assert.equal(cmlQuanLy.body.rows[0].amount_minor, 100000); // 10% thưởng quản lý
  assert.equal(cmlQuanLy.body.rows[0].loai_hoa_hong, 'MANAGEMENT_BONUS');

  assert.equal(count(env, 'commission_ledger'), 2);
  const lai = await call(env, 'POST', '/api/v1/admin/orders/' + order.body.id + '/mark-paid', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(lai.status, 409); // đã PAID rồi, không tính hoa hồng lần 2
  assert.equal(count(env, 'commission_ledger'), 2, 'không tính trùng khi mark-paid lần 2');
});

test('Order không có lead (không có người giới thiệu): mark-paid thành công nhưng không sinh hoa hồng', async () => {
  const env = mkEnv();
  const offer = await call(env, 'POST', '/api/v1/admin/offers', { code: 'GOI-Y', name: 'Gói Y' }, { Authorization: 'Bearer ' + ADMIN });
  const order = await call(env, 'POST', '/api/v1/admin/orders', { offer_id: offer.body.id, amount_minor: 200000 }, { Authorization: 'Bearer ' + ADMIN });
  const paid = await call(env, 'POST', '/api/v1/admin/orders/' + order.body.id + '/mark-paid', undefined, { Authorization: 'Bearer ' + ADMIN });
  assert.equal(paid.status, 200); assert.equal(count(env, 'commission_ledger'), 0);
});

test('Webhook thanh toán EFCare: nhận thô (verified=0), idempotent theo external_event_id, chưa tự đổi trạng thái đơn', async () => {
  const env = mkEnv();
  const r1 = await call(env, 'POST', '/api/v1/integrations/payment-events', { external_event_id: 'evt-efcare-001', event_type: 'PAYMENT_CONFIRMED' });
  assert.equal(r1.status, 202); assert.equal(r1.body.da_xac_thuc, false);
  const r2 = await call(env, 'POST', '/api/v1/integrations/payment-events', { external_event_id: 'evt-efcare-001', event_type: 'PAYMENT_CONFIRMED' });
  assert.equal(r2.body.lap_lai, true);
  assert.equal(count(env, 'payment_events'), 1);
  const row = env.DB.prepare('SELECT verified FROM payment_events').first();
  assert.equal(row.verified, 0);
});

test('commission_policies nạp sẵn đúng 20%/10% theo quyết định anh Linh 10/11/2026', async () => {
  const env = mkEnv();
  const { results } = env.DB.prepare('SELECT code, rate_percent, beneficiary_rule FROM commission_policies ORDER BY code').all();
  assert.deepEqual(results.map(r => ({ ...r })), [
    { code: 'DIRECT_REFERRAL', rate_percent: 20, beneficiary_rule: 'REFERRER' },
    { code: 'MANAGEMENT_BONUS', rate_percent: 10, beneficiary_rule: 'MANAGER' }
  ]);
});
