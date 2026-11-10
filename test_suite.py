# -*- coding: utf-8 -*-
"""Cổng kiểm của khuôn TechOP-OS v1.2 — chạy trên chính mã sinh ra, không dựng bảng riêng.
   python3 test_suite.py   → mã thoát 0 khi đạt hết.
Cần Node ≥ 22.13 (có node:sqlite)."""
import json, os, re, subprocess, sqlite3, sys

GOC = os.path.dirname(os.path.abspath(__file__))
loi = []

def kiem(dk, chu):
    print(("  ĐẠT " if dk else "  LỖI ") + chu)
    if not dk: loi.append(chu)

def chay(*cmd):
    return subprocess.run(cmd, cwd=GOC, capture_output=True, text=True)

print("1. Tệp sinh ra hợp lệ")
js = ["worker.js", "public/sw.js", "public/outbox.js", "d1_node.mjs", "dev_server.mjs", "test_worker.mjs", "test_outbox.mjs"]
for f in js:
    r = chay("node", "--check", f)
    kiem(r.returncode == 0, f"node --check {f}" + ("" if r.returncode == 0 else ": " + r.stderr.strip().splitlines()[0]))
for f in ["public/manifest.json", "package.json"]:
    try: json.load(open(os.path.join(GOC, f), encoding="utf-8")); kiem(True, f"{f} là JSON hợp lệ")
    except Exception as e: kiem(False, f"{f}: {e}")
for f in ["public/index.html", "public/admin.html", "public/ctv.html"]:
    html = open(os.path.join(GOC, f), encoding="utf-8").read()
    for i, m in enumerate(re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)):
        tmp = os.path.join(GOC, f".kiem_{os.path.basename(f)}_{i}.mjs")
        open(tmp, "w", encoding="utf-8").write(re.sub(r"^\s*import .*$", "", m, flags=re.M))
        r = chay("node", "--check", tmp); os.remove(tmp)
        kiem(r.returncode == 0, f"script {i} trong {f} đúng cú pháp")
con_sot = []
for goc, _, ds in os.walk(GOC):
    for t in ds:
        p = os.path.join(goc, t)
        if t.endswith((".js", ".mjs", ".html", ".json", ".sql", ".toml")) and "node_modules" not in p:
            s = open(p, encoding="utf-8").read()
            if re.search(r"__[A-Z_]{3,}__", s) or "{{" in s: con_sot.append(os.path.relpath(p, GOC))
kiem(not con_sot, "không còn chỗ giữ chỗ __X__ hoặc {{ chưa thay" + (": " + ", ".join(con_sot) if con_sot else ""))
tong = sum(os.path.getsize(os.path.join(g, t)) for g, _, ds in os.walk(os.path.join(GOC, "public")) for t in ds)
kiem(tong < 250 * 1024, f"public/ = {tong // 1024} KB (< 250 KB)")

print("2. schema.sql chạy được trên SQLite")
try:
    c = sqlite3.connect(":memory:"); c.executescript(open(os.path.join(GOC, "schema.sql"), encoding="utf-8").read())
    kiem(True, "schema.sql tạo bảng không lỗi")
except Exception as e:
    kiem(False, f"schema.sql: {e}")

print("3. Test worker.js + schema.sql thật, test Outbox với máy chủ HTTP thật")
for t in ["test_worker.mjs", "test_outbox.mjs"]:
    r = chay("node", "--test", t)
    so = re.search(r"ℹ pass (\d+)", r.stdout); hong = re.search(r"ℹ fail (\d+)", r.stdout)
    kiem(r.returncode == 0, f"{t}: {so.group(1) if so else '?'} đạt, {hong.group(1) if hong else '?'} lỗi")
    if r.returncode != 0: print(r.stdout[-3000:])

print("KẾT QUẢ:", "ĐẠT" if not loi else f"LỖI ({len(loi)})")
sys.exit(1 if loi else 0)
