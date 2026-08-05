import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIncusJsonBody } from "../../src/util.mjs";

test("Incus JSON image creation defaults to no expiration", () => {
  const body = normalizeIncusJsonBody("POST", "/1.0/images", { source: { type: "container", name: "u" } });
  assert.equal(body.expires_at, "1970-01-01T00:00:00.000Z");
  assert.equal(normalizeIncusJsonBody("POST", "/1.0/images", { expires_at: "2030-01-01T00:00:00Z" }).expires_at, "2030-01-01T00:00:00Z");
  const binary = Buffer.from("image");
  assert.equal(normalizeIncusJsonBody("POST", "/1.0/images", binary), binary);
  assert.deepEqual(normalizeIncusJsonBody("POST", "/1.0/instances", { name: "x" }), { name: "x" });
});
