import test from "node:test";
import assert from "node:assert/strict";
import { packStateMatchesTarget } from "../../src/operations-state.mjs";

test("cell pack state is bound to its Incus instance identity", () => {
  const state = { target: "cell:p6-cell", target_identity: "uuid-a", state: "installed" };
  assert.equal(packStateMatchesTarget(state, "cell:p6-cell", "uuid-a"), true);
  assert.equal(packStateMatchesTarget(state, "cell:p6-cell", "uuid-b"), false);
  assert.equal(packStateMatchesTarget({ target: "cell:p6-cell", state: "installed" }, "cell:p6-cell", "uuid-a"), false);
  assert.equal(packStateMatchesTarget({ target: "u", state: "installed" }, "u", null), true);
});
