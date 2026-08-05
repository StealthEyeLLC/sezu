import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("binary-firmware carries Binwalk build dependencies and builds offline", () => {
  const packs = JSON.parse(fs.readFileSync(new URL("../../locks/capability-packs.json", import.meta.url), "utf8"));
  const pack = packs.packs.find((item) => item.pack_id === "binary-firmware");
  const fontconfig = pack.components.find((item) => item.component === "libfontconfig-dev");
  assert.deepEqual(fontconfig, {
    component: "libfontconfig-dev", version: "2.15.0-1.1ubuntu2", ecosystem: "apt",
    lock_file: "locks/apt-u.tsv", lock_ref: "package=libfontconfig-dev;architecture=amd64", architecture: "amd64"
  });
  const installer = fs.readFileSync(new URL("../../scripts/install-locked-component.sh", import.meta.url), "utf8");
  assert.match(installer, /component" = binwalk/);
  assert.match(installer, /--locked --offline --release --ignore-rust-version/);
  assert.match(installer, /expected 58 locked C-string compatibility rewrites/);
  assert.match(installer, /unexpected Binwalk primary absolute-path call count/);
  assert.match(installer, /503a066b4c037c440169d995b869046827dbc71263f6e8f3be6d77d4f3229dbd/);
  assert.match(installer, /CARGO_HOME=\/cache\/sezu\/package-managers\/cargo/);
  assert.match(installer, /\*\.deb\) dpkg-deb -x/);
  const forge = fs.readFileSync(new URL("../../scripts/phase3-forge-container.sh", import.meta.url), "utf8");
  assert.match(forge, /cargo fetch --manifest-path "\$source\/Cargo\.toml" --locked/);
});
