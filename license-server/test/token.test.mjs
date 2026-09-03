// The activation token is the anti-tamper core: a client marks itself licensed only when the Ed25519
// signature over the token verifies. Editing any field (or the signature) must fail verification, so a
// user cannot flip a stored value from free to active without the server's private key.
import test from "node:test";
import assert from "node:assert/strict";
import { generateSigningKeyPair, loadPrivateKey, signActivationToken, verifyActivationToken, TOKEN_TTL_MS } from "../token.mjs";

const kp = generateSigningKeyPair();
const priv = loadPrivateKey(kp.privateKeyB64);
const base = { installId: "11111111-1111-4111-8111-111111111111", email: "user@example.test", activationId: "a".repeat(64) };

test("a genuine token verifies", () => {
  const { token, sig } = signActivationToken(priv, base);
  assert.equal(verifyActivationToken(kp.publicKeyB64, token, sig).ok, true);
});

test("flipping any byte of the token fails verification", () => {
  const { token, sig } = signActivationToken(priv, base);
  for (const i of [0, Math.floor(token.length / 2), token.length - 2]) {
    const c = token[i] === "A" ? "B" : "A";
    const bad = token.slice(0, i) + c + token.slice(i + 1);
    assert.equal(verifyActivationToken(kp.publicKeyB64, bad, sig).ok, false, `token[${i}]`);
  }
});

test("flipping the signature fails verification", () => {
  const { token, sig } = signActivationToken(priv, base);
  const bad = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(verifyActivationToken(kp.publicKeyB64, token, bad).ok, false);
});

test("a token signed by a different key fails verification", () => {
  const other = generateSigningKeyPair();
  const { token, sig } = signActivationToken(loadPrivateKey(other.privateKeyB64), base);
  assert.equal(verifyActivationToken(kp.publicKeyB64, token, sig).ok, false, "wrong signer");
  assert.equal(verifyActivationToken(other.publicKeyB64, token, sig).ok, true, "right signer");
});

test("re-signing to extend exp requires the private key (payload is bound by the signature)", () => {
  const { token, sig } = signActivationToken(priv, base, { ttlMs: 1000 });
  const payload = JSON.parse(Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  assert.ok(payload.exp > 0 && payload.v === 1 && payload.installId === base.installId);
  // forge a longer-lived exp in the payload, re-encode, keep the old signature -> must fail
  payload.exp += 10 * 365 * 24 * 3600 * 1000;
  const forged = Buffer.from(JSON.stringify(payload), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyActivationToken(kp.publicKeyB64, forged, sig).ok, false);
});

test("TOKEN_TTL_MS is a sane bound", () => { assert.ok(TOKEN_TTL_MS >= 24 * 3600 * 1000 && TOKEN_TTL_MS <= 30 * 24 * 3600 * 1000); });
