import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("on-demand Python packs install from the locked artifact directory", () => {
  const source = fs.readFileSync(new URL("../../src/operations-state.mjs", import.meta.url), "utf8");
  assert.match(source, /--no-index --find-links \/cache\/sezu\/sources\/python\/artifacts/);
  assert.doesNotMatch(source, /--find-links \/cache\/sezu\/sources\/python "\$2==\$3"/);
});
