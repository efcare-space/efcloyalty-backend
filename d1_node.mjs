// Bộ chuyển D1 → SQLite thật của Node (node:sqlite, Node ≥ 22.13). Không giả lập logic:
// mọi câu SQL trong worker.js chạy nguyên văn trên SQLite, batch chạy trong BEGIN/COMMIT như D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    if (args.some(a => a === undefined)) throw new Error('D1_TYPE_ERROR: undefined trong bind');
    return new Stmt(this.db, this.sql, args);
  }
  first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  all() { return { success: true, results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
}

export class D1Node {
  constructor(schemaPath) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (schemaPath) this.db.exec(readFileSync(schemaPath, 'utf8'));
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = stmts.map(s => s.run()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
