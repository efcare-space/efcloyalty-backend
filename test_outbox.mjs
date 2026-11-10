// Test outbox.js với máy chủ HTTP thật (node:http) và fetch thật. Kho dùng Map trong bộ nhớ thay IndexedDB
// (Node không có IndexedDB); logic gửi lại, backoff, khoá được chạy nguyên văn. Chạy: node --test test_outbox.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { taoOutbox, tinhCho, phanLoai, MAX_LAN, CAP_MS } from './public/outbox.js';

const khoNho = () => { const m = new Map(); return {
  m, put: async v => { m.set(v.client_tx_id, structuredClone(v)); }, delete: async k => { m.delete(k); }, all: async () => [...m.values()]
}; };

// Máy chủ trả lời theo kịch bản: mỗi phần tử là 'dut' (cắt kết nối) hoặc [status, headers]
async function mayChu(kichBan) {
  const nhan = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      nhan.push(JSON.parse(b));
      const buoc = kichBan.length > 1 ? kichBan.shift() : kichBan[0];
      if (buoc === 'dut') return req.socket.destroy();
      const [st, h = {}] = buoc;
      res.writeHead(st, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify({ ok: st < 300, ma: st < 300 ? null : 'MA_' + st }));
    });
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/api/v1/submit`, nhan, dong: () => new Promise(r => s.close(r)) };
}
const dongHo = () => { let t = 1_000_000; return { now: () => t, toi: ms => { t += ms; } }; };

test('backoff: tăng gấp đôi, có trần 5 phút, full jitter', () => {
  assert.equal(tinhCho(3, () => 0), 0);
  assert.equal(tinhCho(1, () => 0.9999), 3999);
  assert.equal(tinhCho(3, () => 0.9999), 15998);
  assert.ok(tinhCho(30, () => 0.9999) < CAP_MS);
  assert.deepEqual([200, 201, 408, 429, 500, 503, 400, 404, 409].map(phanLoai),
    ['XONG', 'XONG', 'THU_LAI', 'THU_LAI', 'THU_LAI', 'THU_LAI', 'LOI', 'LOI', 'LOI']);
});

test('mất mạng: giữ trong kho, hẹn lại; có mạng: gửi đúng client_tx_id, xoá khỏi kho', async () => {
  const sv = await mayChu(['dut', [200]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now, random: () => 0.5 });
  await ob.them(sv.url, { client_tx_id: 'tx-a', name: 'A' });
  const r1 = await ob.xa();
  assert.equal(r1.cho.length, 1); assert.equal(kho.m.get('tx-a').lan, 1); assert.equal(r1.hen_luc, dh.now() + 2000);
  dh.toi(2000);
  const r2 = await ob.xa();
  assert.equal(r2.xong.length, 1); assert.equal(r2.xong[0].data.ok, true); assert.equal(kho.m.size, 0);
  assert.deepEqual(sv.nhan.map(x => x.client_tx_id), ['tx-a', 'tx-a']);
  await sv.dong();
});

test('chưa đến giờ hẹn: không gửi', async () => {
  const sv = await mayChu([[503]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now, random: () => 0.9 });
  await ob.them(sv.url, { client_tx_id: 'tx-b' });
  await ob.xa(); await ob.xa(); await ob.xa();
  assert.equal(sv.nhan.length, 1);
  await sv.dong();
});

test('4xx (dữ liệu sai): LOI ngay, không gửi lại', async () => {
  const sv = await mayChu([[400]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now });
  await ob.them(sv.url, { client_tx_id: 'tx-c' });
  const r = await ob.xa();
  assert.equal(r.loi.length, 1); assert.equal(r.loi[0].item.ma, 'MA_400');
  dh.toi(CAP_MS * 10); await ob.xa();
  assert.equal(sv.nhan.length, 1); assert.equal((await ob.dangLoi()).length, 1);
  await sv.dong();
});

test('5xx kéo dài: dừng sau MAX_LAN lần, chuyển LOI', async () => {
  const sv = await mayChu([[503]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now, random: () => 0.9999 });
  await ob.them(sv.url, { client_tx_id: 'tx-d' });
  for (let i = 0; i < MAX_LAN + 3; i++) { await ob.xa(); dh.toi(CAP_MS); }
  assert.equal(sv.nhan.length, MAX_LAN); assert.equal(kho.m.get('tx-d').status, 'LOI');
  await sv.dong();
});

test('429 có Retry-After: chờ ít nhất bằng đó', async () => {
  const sv = await mayChu([[429, { 'Retry-After': '120' }]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now, random: () => 0 });
  await ob.them(sv.url, { client_tx_id: 'tx-e' });
  const r = await ob.xa();
  assert.equal(r.hen_luc, dh.now() + 120000);
  await sv.dong();
});

test('hai lượt gửi cùng lúc: mỗi mục chỉ gửi 1 lần', async () => {
  const sv = await mayChu([[200]]); const kho = khoNho(); const dh = dongHo();
  const ob = taoOutbox({ store: kho, now: dh.now });
  for (const t of ['tx-f1', 'tx-f2', 'tx-f3']) await ob.them(sv.url, { client_tx_id: t });
  await Promise.all([ob.xa(), ob.xa(), ob.xa()]);
  assert.equal(sv.nhan.length, 3); assert.equal(new Set(sv.nhan.map(x => x.client_tx_id)).size, 3);
  await sv.dong();
});

test('thiếu client_tx_id: từ chối ngay khi thêm', async () => {
  const ob = taoOutbox({ store: khoNho() });
  await assert.rejects(() => ob.them('http://x', { name: 'A' }));
});
