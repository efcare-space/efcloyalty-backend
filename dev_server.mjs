// Chạy thử cục bộ không cần wrangler: phục vụ public/ và chuyển /api/* vào worker.js THẬT trên SQLite thật.
//   node dev_server.mjs [cổng]   → http://localhost:8787  (quản trị: /admin.html, khoá: dev-admin)
// Cấu hình dưới đây CHỈ để chạy thử trên máy, không phải giá hay tài khoản thật.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';
import { D1Node } from './d1_node.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// EF_ID_SERVER_URL cố ý để trống — đăng nhập/đăng ký CTV sẽ báo lỗi cho tới khi bạn tự trỏ vào máy chủ EF-ID
// thật hoặc máy giả lập cục bộ. KHÔNG tự điền https://efc-may-chu.efcare.workers.dev vào đây để test tay —
// sẽ tạo tài khoản thật trên cộng đồng thật.
const env = { DB: new D1Node(join(HERE, 'schema.sql')), ADMIN_TOKEN: 'dev-admin', CONSENT_VER: 'v2', ALLOWED_PROGRAM_CODES: 'EFCARE' };
const LOAI = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const cong = Number(process.argv[2]) || 8787;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const p = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const b = await readFile(join(HERE, 'public', p));
    const headers = { 'Content-Type': LOAI[extname(p)] || 'application/octet-stream' };
    if (p === '/sw.js') headers['Cache-Control'] = 'no-cache';   // sw.js phải luôn kiểm bản mới, không để trình duyệt giữ bản cũ
    res.writeHead(200, headers); res.end(b);
  }
  catch { res.writeHead(404); res.end('Không có'); }
}).listen(cong, () => console.log(`Chạy thử: http://localhost:${cong} · quản trị: /admin.html (khoá dev-admin) · webhook: Apikey dev-sepay`));
