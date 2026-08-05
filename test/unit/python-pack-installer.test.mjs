import test from "node:test";
import assert from "node:assert/strict";
import { pythonPackInstallScript } from "../../src/operations-state.mjs";

test("on-demand Python packs stage locked artifacts by canonical filename", () => {
  const script = pythonPackInstallScript();
  assert.match(script, /locked-index\.json/);
  assert.match(script, /item\.get\('filename'\)/);
  assert.match(script, /destination\.symlink_to\(source\)/);
  assert.match(script, /--no-index --find-links "\$stage"/);
  assert.match(script, /python3 -m venv "\$root"/);
  assert.doesNotMatch(script, /--find-links \/cache\/sezu\/sources\/python\/artifacts/);
});
