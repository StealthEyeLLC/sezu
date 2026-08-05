import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { binwalkBuildScript } from "../../src/operations-state.mjs";

test("Binwalk builds with the exact cached Rust toolchain and locked Cargo graph", () => {
  const script = binwalkBuildScript();
  assert.match(script, /cargo build --release --locked --offline/);
  assert.match(script, /RUST_FONTCONFIG_DLOPEN=1/);
  assert.match(script, /target\/release\/binwalk/);
  const source = fs.readFileSync(new URL("../../src/operations-state.mjs", import.meta.url), "utf8");
  assert.match(source, /BINWALK_RUST_VERSION = '1\.97\.0'/);
  assert.match(source, /sources\/cargo\/binwalk\/3\.1\.0/);
  assert.match(source, /component\.component === 'binwalk'/);
});
