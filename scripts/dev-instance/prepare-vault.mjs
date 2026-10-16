#!/usr/bin/env node
/**
 * Turns the live owner's hebi8.yaml into the dev instance's: drops `owner` (single-user mode, full
 * read and write over Tailscale without a login) and points each local dataset at the copy that came
 * with it. Comments and order stay (parseDocument, as in src/lib/vault.ts).
 * Usage: node prepare-vault.mjs <app dir> <hebi8.yaml> <datasets dir> [<where that dir will be>]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [app, file, datasets, final = datasets] = process.argv.slice(2);
if (!app || !file || !datasets) {
  console.error("usage: prepare-vault.mjs <app dir> <hebi8.yaml> <datasets dir> [<where that dir will be>]");
  process.exit(2);
}
const { parseDocument } = createRequire(path.join(path.resolve(app), "package.json"))("yaml");

const doc = parseDocument(fs.readFileSync(file, "utf8"));
if (doc.errors.length > 0) throw doc.errors[0];
doc.delete("owner");
const sets = doc.get("datasets");
if (sets && typeof sets.items === "object") {
  for (const pair of sets.items) {
    const name = String(pair.key?.value ?? pair.key);
    if (!fs.existsSync(path.join(datasets, name, "hebi8-dataset.yaml"))) continue;
    const dir = path.join(final, name);
    // keep the scalar node so its trailing comment stays
    if (pair.value && "value" in pair.value) pair.value.value = dir;
    else doc.setIn(["datasets", name], dir);
  }
}
doc.commentBefore = [" dev 实例：每天从线上 owner 的 vault 覆盖（scripts/dev-instance/hebi8-dev.sh sync），这里的改动不会留下", doc.commentBefore]
  .filter(Boolean)
  .join("\n");
fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
