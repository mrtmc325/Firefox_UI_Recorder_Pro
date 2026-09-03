// Request preamble shared by the extension (its own WebCrypto copy) and this server.
// A request is accepted only when it carries `X-UIR-Preamble: v1.<ts>.<nonce>.<hmac>` where
// hmac = HMAC-SHA256(clientHmac, "v1.<ts>.<nonce>.<METHOD>.<path>.<sha256(body)>"), the timestamp is
// within MAX_SKEW_MS of server time and the nonce has not been seen before. Anything else -> bare 404.
// The HMAC key ships inside a public extension, so this is a deterrent against scanners and casual abuse,
// not a proof of identity; seats and revocation are enforced server-side regardless.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PREAMBLE_HEADER = "x-uir-preamble";
export const CLIENT_HEADER = "x-uir-client";
export const PREAMBLE_VERSION = "v1";
export const MAX_SKEW_MS = 5 * 60 * 1000;
// Nonces only need to be remembered for the skew window: a nonce older than MAX_SKEW_MS is already
// rejected by the timestamp check, so it can never be replayed.
export const NONCE_TTL_MS = MAX_SKEW_MS;

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

// Generational replay cache: two rotating Sets keyed by nonce. A nonce is "seen" if it is in either
// generation. Rotating every TTL/2 and dropping the older generation bounds memory to ~two windows'
// worth of nonces with O(1) work per request, and — unlike a fixed-cap Map — never refuses a
// legitimate request under sustained load. Safe up to ~500 req/s (≈150k nonces per window).
export class NonceCache {
  constructor(ttlMs = NONCE_TTL_MS) {
    this.halfTtl = Math.max(1000, Math.floor(ttlMs / 2));
    this.current = new Set();
    this.previous = new Set();
    this.rotatedAt = Date.now();
  }
  rotate(now) {
    if (now - this.rotatedAt < this.halfTtl) return;
    this.previous = this.current;
    this.current = new Set();
    this.rotatedAt = now;
  }
  // Returns true if the nonce is fresh (and records it); false if it was already seen (replay).
  claim(nonce, now = Date.now()) {
    this.rotate(now);
    if (this.current.has(nonce) || this.previous.has(nonce)) return false;
    this.current.add(nonce);
    return true;
  }
  size() { return this.current.size + this.previous.size; }
}

// `secret` may be a single string or an array (current + previous during a key rotation). The nonce is
// claimed only after a MAC verifies, so a rejected request never consumes a nonce.
export function verifyPreamble(secret, header, { method, path, body, now = Date.now(), nonces }) {
  const parts = String(header || "").split(".");
  if (parts.length !== 4 || parts[0] !== PREAMBLE_VERSION) return { ok: false, reason: "shape" };
  const [, tsRaw, nonce, mac] = parts;
  const ts = Number(tsRaw);
  if (!/^\d{10,16}$/.test(tsRaw) || !Number.isFinite(ts)) return { ok: false, reason: "timestamp" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "skew" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "nonce" };
  if (!/^[0-9a-f]{64}$/.test(mac)) return { ok: false, reason: "mac-shape" };
  const secrets = Array.isArray(secret) ? secret : [secret];
  const macBuf = Buffer.from(mac, "hex");
  let matched = false;
  for (const s of secrets) {
    if (!s) continue;
    const expected = Buffer.from(computePreambleMac(s, { ts: tsRaw, nonce, method, path, body }), "hex");
    if (expected.length === macBuf.length && timingSafeEqual(expected, macBuf)) { matched = true; break; }
  }
  if (!matched) return { ok: false, reason: "mac" };
  if (nonces && !nonces.claim(nonce, now)) return { ok: false, reason: "replay" };
  return { ok: true };
}
