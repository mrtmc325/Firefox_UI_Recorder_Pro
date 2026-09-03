// Read automatically by web-ext (build, lint, run): ship and lint only the runtime files.
export default {
  ignoreFiles: [
    "docs", "dist", "license-server", "sbom", "README.md", "README.txt", "CHANGELOG.md",
    ".gitleaks.toml", ".claude", "web-ext-config.mjs"
  ],
  artifactsDir: "dist",
  build: { overwriteDest: true }
};
