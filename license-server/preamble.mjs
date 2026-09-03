// Request preamble shared by the extension (its own copy, WebCrypto) and this server.
// A request is accepted only when it carries `X-UIR-Preamble: v1.<ts>.<nonce>.<hmac>` where
// hmac = HMAC-SHA256(clientSecret, "v1.<ts>.<nonce>.<METHOD>.<path>.<sha256(body)>"), the timestamp is
// within MAX_SKEW_MS of server time and the nonce has not been seen before. Anything else gets a bare 404.
// The secret ships inside a public extension, so this is a deterrent against scanners and casual abuse,
// not a proof of identity; seats and revocation are enforced server-side regardless.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PREAMBLE_HEADER = "x-uir-preamble";
export const CLIENT_HEADER = "x-uir-client";
export const PREAMBLE_VERSION = "v1";
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 10 * 60 * 1000;

export function sha256Hex(text) {
  return createHash("sha256").update(text || "", "utf8").digest("hex");
}

export function computePreambleMac(secret, { ts, nonce, method, path, body }) {
  const material = `${PREAMBLE_VERSION}.${ts}.${nonce}.${String(method).toUpperCase()}.${path}.${sha256Hex(body)}`;
  return createHmac("sha256", secret).update(material, "utf8").digest("hex");
}

export function buildPreamble(secret, fields) {
  return `${PREAMBLE_VERSION}.${fields.ts}.${fields.nonce}.${computePreambleMac(secret, fields)}`;
}

// Bounded nonce memory: Map nonce -> expiry; sweep on insert.
export class NonceCache {
  constructor(ttlMs = NONCE_TTL_MS, max = 50000) { this.ttlMs = ttlMs; this.max = max; this.map = new Map(); }
  sweep(now) { for (const [k, exp] of this.map) if (exp <= now) this.map.delete(k); }
  claim(nonce, now = Date.now()) {
    if (this.map.size > this.max) this.sweep(now);
    if (this.map.size > this.max) return false; // still full: refuse rather than grow unbounded
    if (this.map.has(nonce) && this.map.get(nonce) > now) return false;
    this.map.set(nonce, now + this.ttlMs);
    return true;
  }
}

export function verifyPreamble(secret, header, { method, path, body, now = Date.now(), nonces }) {
  const parts = String(header || "").split(".");
  if (parts.length !== 4 || parts[0] !== PREAMBLE_VERSION) return { ok: false, reason: "shape" };
  const [, tsRaw, nonce, mac] = parts;
  const ts = Number(tsRaw);
  if (!/^\d{10,16}$/.test(tsRaw) || !Number.isFinite(ts)) return { ok: false, reason: "timestamp" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "skew" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "nonce" };
  if (!/^[0-9a-f]{64}$/.test(mac)) return { ok: false, reason: "mac-shape" };
  const expected = computePreambleMac(secret, { ts: tsRaw, nonce, method, path, body });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(mac, "hex"))) return { ok: false, reason: "mac" };
  if (nonces && !nonces.claim(nonce, now)) return { ok: false, reason: "replay" };
  return { ok: true };
}
