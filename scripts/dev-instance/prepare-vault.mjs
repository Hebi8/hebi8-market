#!/usr/bin/env node
/**
 * Turns the live owner's hebi8.yaml into the dev instance's: drops `owner` (single-user mode, full
 * read and write over Tailscale without a login) and points each local dataset at <where that dir will
 * be>/<name>, whether a copy came or not: never at the live directory. With HEBI8_DEV_SYNC_AT set, the dev instance syncs bars once a day at that time instead of at
 * the owner's sync.at: it takes the live cache every day anyway and shares the live instance's
 * upstream sources. Comments and order stay (parseDocument, as in src/lib/vault.ts).
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
if (process.env.HEBI8_DEV_SYNC_AT) {
  const at = doc.createNode([process.env.HEBI8_DEV_SYNC_AT], { flow: true });
  at.items[0].type = "QUOTE_DOUBLE";
  at.comment = " dev 实例每天只同步一次（hebi8-dev.sh 的 APP_SYNC_AT）";
  doc.setIn(["sync", "at"], at);
}
const sets = doc.get("datasets");
if (sets && typeof sets.items === "object") {
  for (const pair of sets.items) {
    const name = String(pair.key?.value ?? pair.key);
    const location = pair.value?.value ?? pair.value;
    if (typeof location !== "string" || /^(https:\/\/|ssh:\/\/|file:\/\/|git@[^:]+:)/.test(location)) continue;
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
