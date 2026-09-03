// SQLite (node:sqlite, stdlib) persistence for licenses, activations, and the audit trail.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const nowIso = () => new Date().toISOString();

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      seats INTEGER NOT NULL CHECK (seats >= 0),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activations (
      id INTEGER PRIMARY KEY,
      license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      install_id TEXT NOT NULL,
      activation_id TEXT NOT NULL UNIQUE,
      ext_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      activated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activations_license_status ON activations(license_id, status);
    CREATE INDEX IF NOT EXISTS idx_activations_install ON activations(license_id, install_id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
  `);
  return new Store(db);
}

export class Store {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }
  audit(actor, action, detail) {
    this.db.prepare("INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)")
      .run(nowIso(), String(actor || "system").slice(0, 200), String(action).slice(0, 80), JSON.stringify(detail || {}).slice(0, 2000));
  }
  listAudit(limit = 200) { return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))); }

  // ---- licenses ----
  listLicenses() {
    return this.db.prepare(`
      SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') AS active_seats
      FROM licenses l ORDER BY l.created_at DESC`).all();
  }
  getLicense(id) { return this.db.prepare("SELECT * FROM licenses WHERE id = ?").get(id) || null; }
  getLicenseByEmail(email) { return this.db.prepare("SELECT * FROM licenses WHERE email = ? COLLATE NOCASE").get(normalizeEmail(email)) || null; }
  createLicense(email, seats, note = "", actor = "admin") {
    const e = normalizeEmail(email); const s = clampSeats(seats); const ts = nowIso();
    const info = this.db.prepare("INSERT INTO licenses (email, seats, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(e, s, String(note || "").slice(0, 500), ts, ts);
    this.audit(actor, "license.create", { email: e, seats: s });
    return this.getLicense(Number(info.lastInsertRowid));
  }
  updateLicense(id, { seats, note }, actor = "admin") {
    const lic = this.getLicense(id); if (!lic) return null;
    const s = seats === undefined ? lic.seats : clampSeats(seats);
    const n = note === undefined ? lic.note : String(note).slice(0, 500);
    this.tx(() => {
      this.db.prepare("UPDATE licenses SET seats = ?, note = ?, updated_at = ? WHERE id = ?").run(s, n, nowIso(), id);
      this.enforceSeats(id, "seat-limit");
    });
    this.audit(actor, "license.update", { id, seats: s });
    return this.getLicense(id);
  }
  deleteLicense(id, actor = "admin") {
    const lic = this.getLicense(id); if (!lic) return false;
    this.db.prepare("DELETE FROM licenses WHERE id = ?").run(id);
    this.audit(actor, "license.delete", { id, email: lic.email });
    return true;
  }

  // ---- activations ----
  listActivations(licenseId) { return this.db.prepare("SELECT * FROM activations WHERE license_id = ? ORDER BY activated_at ASC, id ASC").all(licenseId); }
  countActive(licenseId) { return this.db.prepare("SELECT COUNT(*) AS c FROM activations WHERE license_id = ? AND status = 'active'").get(licenseId).c; }
  getActivationByActivationId(activationId) { return this.db.prepare("SELECT * FROM activations WHERE activation_id = ?").get(String(activationId)) || null; }
  getActivation(id) { return this.db.prepare("SELECT * FROM activations WHERE id = ?").get(id) || null; }
  findActiveByInstall(licenseId, installId) {
    return this.db.prepare("SELECT * FROM activations WHERE license_id = ? AND install_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(licenseId, String(installId)) || null;
  }
  // Seat rule: the newest activation always wins; once active seats exceed the purchased count the
  // OLDEST active activation is revoked (demoted to free on its next validation).
  enforceSeats(licenseId, reason = "seat-limit") {
    const lic = this.getLicense(licenseId); if (!lic) return [];
    const revoked = [];
    while (this.countActive(licenseId) > lic.seats) {
      const oldest = this.db.prepare("SELECT * FROM activations WHERE license_id = ? AND status = 'active' ORDER BY activated_at ASC, id ASC LIMIT 1").get(licenseId);
      if (!oldest) break;
      this.revokeActivation(oldest.id, reason, "system");
      revoked.push(oldest.id);
    }
    return revoked;
  }
  activate({ email, installId, extVersion }) {
    const lic = this.getLicenseByEmail(email);
    if (!lic) return { ok: false, status: "unknown" };
    if (lic.seats <= 0) return { ok: false, status: "no-seats" };
    return this.tx(() => {
      const existing = this.findActiveByInstall(lic.id, installId);
      const ts = nowIso();
      if (existing) {
        this.db.prepare("UPDATE activations SET last_seen_at = ?, ext_version = ? WHERE id = ?").run(ts, String(extVersion || "").slice(0, 40), existing.id);
        this.audit(lic.email, "activation.reuse", { activation: existing.activation_id.slice(0, 8), install: String(installId).slice(0, 8) });
        return { ok: true, status: "active", activationId: existing.activation_id, seats: lic.seats, activeSeats: this.countActive(lic.id) };
      }
      const activationId = randomBytes(32).toString("hex");
      this.db.prepare("INSERT INTO activations (license_id, install_id, activation_id, ext_version, status, activated_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .run(lic.id, String(installId).slice(0, 80), activationId, String(extVersion || "").slice(0, 40), ts, ts);
      const demoted = this.enforceSeats(lic.id, "seat-limit");
      this.audit(lic.email, "activation.create", { activation: activationId.slice(0, 8), install: String(installId).slice(0, 8), demoted: demoted.length });
      return { ok: true, status: "active", activationId, seats: lic.seats, activeSeats: this.countActive(lic.id), demoted: demoted.length };
    });
  }
  validate({ email, installId, activationId }) {
    const lic = this.getLicenseByEmail(email);
    const act = this.getActivationByActivationId(activationId);
    if (!lic || !act || act.license_id !== lic.id || act.install_id !== String(installId)) return { ok: false, status: "unknown" };
    if (act.status !== "active") return { ok: false, status: "revoked", reason: act.revoke_reason || "revoked" };
    this.db.prepare("UPDATE activations SET last_seen_at = ? WHERE id = ?").run(nowIso(), act.id);
    return { ok: true, status: "active", seats: lic.seats };
  }
  deactivate({ email, installId, activationId }) {
    const lic = this.getLicenseByEmail(email);
    const act = this.getActivationByActivationId(activationId);
    if (!lic || !act || act.license_id !== lic.id || act.install_id !== String(installId)) return { ok: false, status: "unknown" };
    if (act.status === "active") this.revokeActivation(act.id, "user-deactivated", lic.email);
    return { ok: true, status: "revoked" };
  }
  revokeActivation(id, reason, actor = "admin") {
    const act = this.getActivation(id); if (!act || act.status !== "active") return false;
    this.db.prepare("UPDATE activations SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ?").run(nowIso(), String(reason).slice(0, 80), id);
    this.audit(actor, "activation.revoke", { activation: act.activation_id.slice(0, 8), reason });
    return true;
  }
}

export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid email");
  return e;
}
export function clampSeats(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error("invalid seats");
  return n;
}
