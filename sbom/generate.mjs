// Regenerates sbom/license-server.cdx.json (CycloneDX 1.5) for the zero-dependency license server.
// Node stdlib only. Run: node sbom/generate.mjs   (version tracks manifest.json).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).version;
let commit = "unknown";
try { commit = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim(); } catch {}

// Source files that ship or define the server (stdlib-only; no third-party components exist).
const LS = join(REPO, "license-server");
const files = ["cli.mjs", "db.mjs", "preamble.mjs", "server.mjs", "token.mjs"]
  .concat(readdirSync(join(LS, "test")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `test/${f}`));

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const agpl = [{ license: { id: "AGPL-3.0-only" } }];

const components = [
  {
    type: "platform", name: "nodejs", version: ">=24.0.0",
    description: "Runtime. Uses only built-in modules: node:http, node:https, node:sqlite, node:crypto, node:util, node:fs, node:net, node:url. No npm dependencies, no lockfile.",
    properties: [{ name: "dependencies", value: "none (standard library only)" }],
  },
  ...files.map((rel) => ({
    type: "file", name: `license-server/${rel}`, version,
    hashes: [{ alg: "SHA-256", content: sha256(join(LS, rel)) }],
    licenses: agpl,
  })),
];

const doc = {
  bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    authors: [{ name: "Tristan Conner" }],
    tools: [{ name: "repo-sbom-script", version: "1" }],
    component: {
      type: "application", name: "uir-license-server", version, "bom-ref": `uir-license-server@${version}`,
      description: "UI Recorder Pro license server: activation, seat enforcement, Ed25519-signed tokens, admin UI. Node.js stdlib only.",
      licenses: agpl,
      properties: [{ name: "source.commit", value: commit }],
    },
  },
  components,
};
writeFileSync(join(REPO, "sbom", "license-server.cdx.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`SBOM regenerated: v${version}, ${files.length} files, commit ${commit.slice(0, 12)}`);
