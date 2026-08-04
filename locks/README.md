# SEZU 0.1.0 Release Locks

These files are the complete Phase 0 build-input set. Later phases consume them without resolving moving versions.

- `apt-host.tsv` and `apt-u.tsv`: exact package closures with architecture, source URL, size, and SHA-256.
- `direct-artifacts.tsv`: exact direct downloads and Git release identities.
- `npm-lock.json`: complete JavaScript dependency closure.
- `python-uv.lock`: complete Python 3.12 dependency closure with markers and hashes.
- `playwright-browsers.json`: Playwright 1.62.1 Chromium artifact only.
- `ubuntu-image.json`: immutable Ubuntu Noble image serial and fingerprints.
- `capability-packs.json`: the seven base, seventeen language, and eight other on-demand packs connected to lock entries.
- `service-images.json`: seventeen linux/amd64 service templates using immutable OCI digests.
- `licenses.json`: minimal third-party release-license metadata.

Run `python3 scripts/validate-locks.py` from the repository root to check structural consistency.
