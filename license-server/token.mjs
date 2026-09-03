// Ed25519-signed activation tokens. The server holds the private key and signs a token on every
// successful activate/validate; the extension bakes the matching public key and marks itself licensed
// ONLY when the signature verifies, the token has not expired, and the install/email match. This makes
// the browser-side license state unforgeable by editing storage — a valid signature needs the private key.
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";

export const TOKEN_VERSION = 1;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // offline validity; refreshed on each 48 h check-in

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Generate a keypair for the owner. Returns the private key (PKCS8, base64 — for the server env) and the
// raw 32-byte public key (base64 — to bake into the extension's WebCrypto verify).
export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32); // last 32 bytes of SPKI = raw key
  return { privateKeyB64: Buffer.from(pkcs8).toString("base64"), publicKeyB64: Buffer.from(rawPub).toString("base64") };
}

export function loadPrivateKey(privateKeyB64) {
  return createPrivateKey({ key: Buffer.from(String(privateKeyB64), "base64"), format: "der", type: "pkcs8" });
}

// token payload string (base64url of canonical JSON) + detached signature (base64url).
export function signActivationToken(privateKey, { installId, email, activationId, ttlMs = TOKEN_TTL_MS, now = Date.now() }) {
  const payload = b64url(JSON.stringify({ v: TOKEN_VERSION, installId, email, activationId, exp: now + ttlMs }));
  const sig = b64url(sign(null, Buffer.from(payload, "utf8"), privateKey));
  return { token: payload, sig };
}

// Verification helper (used by tests; the extension has its own WebCrypto version). rawPublicKeyB64 is the
// 32-byte raw Ed25519 public key.
export function verifyActivationToken(rawPublicKeyB64, token, sig, { now = Date.now() } = {}) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), fromB64url(rawPublicKeyB64)]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (!verify(null, Buffer.from(String(token), "utf8"), pub, fromB64url(sig))) return { ok: false, reason: "sig" };
    const claims = JSON.parse(fromB64url(token).toString("utf8"));
    if (claims.v !== TOKEN_VERSION) return { ok: false, reason: "version" };
    if (Number(claims.exp) < now) return { ok: false, reason: "expired" };
    return { ok: true, claims };
  } catch (e) {
    return { ok: false, reason: "malformed" };
  }
}
