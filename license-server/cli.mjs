#!/usr/bin/env node
// Owner CLI: node cli.mjs gen-secret | hash-password | add-license <email> <seats> [note] | list
import { randomBytes } from "node:crypto";
import { hashPassword } from "./server.mjs";
import { openDb } from "./db.mjs";

const [cmd, ...args] = process.argv.slice(2);
const readStdin = () => new Promise((r) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { s += c; }); process.stdin.on("end", () => r(s)); });

if (cmd === "gen-hmac") {
  process.stdout.write(randomBytes(32).toString("hex") + "\n");
} else if (cmd === "hash-password") {
  // Password comes from LICENSE_ADMIN_PASSWORD or stdin so it never lands in shell history.
  const pw = (process.env.LICENSE_ADMIN_PASSWORD || (await readStdin())).replace(/\r?\n$/, "");
  if (pw.length < 12) { console.error("Password must be at least 12 characters."); process.exit(2); }
  process.stdout.write((await hashPassword(pw)) + "\n");
} else if (cmd === "add-license") {
  const [email, seats, ...note] = args;
  if (!email || !seats) { console.error("usage: add-license <email> <seats> [note]"); process.exit(2); }
  const store = openDb(process.env.LICENSE_DB_PATH || "./data/license.db");
  const lic = store.createLicense(email, seats, note.join(" "), "cli");
  console.log(`license #${lic.id} ${lic.email} seats=${lic.seats}`);
  store.close();
} else if (cmd === "list") {
  const store = openDb(process.env.LICENSE_DB_PATH || "./data/license.db");
  for (const l of store.listLicenses()) console.log(`#${l.id}\t${l.email}\t${l.active_seats}/${l.seats}\t${l.note}`);
  store.close();
} else {
  console.error("usage: node cli.mjs gen-hmac | hash-password | add-license <email> <seats> [note] | list");
  process.exit(2);
}
