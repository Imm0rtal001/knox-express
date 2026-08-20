const fs = require("fs");
const path = require("path");
const assert = require("assert");
const manifest = require("../manifest.json");
const state = require("../data/providers.json");

assert.equal(manifest.id, "com.knox.express");
assert(manifest.resources.includes("stream"));
assert(manifest.types.includes("movie"));
for (const p of Object.values(state)) {
  const file = path.join(__dirname, "..", "providers", p.filename);
  assert(fs.existsSync(file), `Missing ${p.id}: ${file}`);
}
console.log(`OK: ${Object.keys(state).length} providers registered and all files exist.`);
