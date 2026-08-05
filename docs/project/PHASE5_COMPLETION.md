# Phase 5 Completion Record

Date: 2026-08-05
Status: Complete, with credential rotation pending
Phase boundary: Phase 6 has not started

## Delivered state

- The dedicated OpenAI Secure MCP tunnel is active and enabled on the SEZU VPS.
- Tunnel ID: `tunnel_6a72b49594188191b8d5afbd59666b6b`
- The ChatGPT workspace app is published as `SEZU`.
- The public MCP surface contains exactly one tool: `call_sezu`.
- `call_sezu` dispatches native `sezu.*` operations through the local root supervisor.
- The live protocol is `SEZU1/1.0.0`.
- SEZU reports version `0.1.0` and 184 registered operations.
- No public SEZU listener is exposed; the tunnel is outbound-only.
- The construction path and Phase 6 boundary remain preserved.

## Live remote acceptance evidence

All requests below were made through the published ChatGPT SEZU app and Secure MCP tunnel.

- `sezu.health` on `host`: passed; request `c1cffa84-d170-48b1-8f66-ca84829f1ced`.
- `sezu.version` on `host`: passed; request `17601760-6b63-4a55-a609-3404d7847e3d`.
- `sezu.capabilities` on `host`: passed with 184 operations; request `063bffc0-6702-42a4-8ca6-0f76920ca009`.
- Harmless remote inspection using `sezu.file.list`: passed; request `3c4e394f-81bf-4c38-bad1-fccf4d725527`.
- Controlled remote write using `sezu.file.write` with an idempotency key: passed; request `d35c93a5-2e55-4a39-af91-fd857fbb2c30`.
- Remote readback verified the exact content; request `7555e159-9f0c-492b-8648-4ecc817ef889`.
- Controlled cleanup using `sezu.file.remove` with an idempotency key: passed; request `90cea6ef-979e-41a2-9c98-a97868cac40d`.

## Local validation

The Phase 5 validation script passed all gates:

- identity
- credentials
- local runtime
- tunnel runtime
- outbound-only networking
- construction preservation
- Phase 6 boundary

Repository source checks, unit tests, and runtime build also passed. The permanent activation fixes were pushed at commit `b0d4b265d1d836fa76f817ecc1bb88d9cc5450cf`.

## Required credential rotation

The current runtime API key was exposed in conversation history and must be treated as compromised. After a replacement OpenAI runtime key is issued with Tunnels Read and Use permissions, install the replacement on the VPS, verify tunnel reconnection and a live `sezu.health` call, then revoke the exposed key. Replace or delete the GitHub Actions secret named `RUNTIME` if it contains the exposed key.

No API key value is recorded in this repository.
