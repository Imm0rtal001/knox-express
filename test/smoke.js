const fs = require("fs");
const path = require("path");
const assert = require("assert");
const manifest = require("../manifest.json");
const state = require("../data/providers.json");

assert.equal(manifest.id, "com.knox.express");
assert(Array.isArray(manifest.resources) && manifest.resources.some(r => r && r.name === "stream"));
assert(manifest.types.includes("movie"));
for (const p of Object.values(state)) {
  const filename = path.basename(String(p.filename || "").replace(/\\/g, "/"));
  const file = path.join(__dirname, "..", "providers", filename);
  assert(filename && fs.existsSync(file), `Missing ${p.id}: ${file}`);
}
console.log(`OK: ${Object.keys(state).length} providers registered and all files exist.`);
