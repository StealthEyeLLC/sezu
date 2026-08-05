# Phase 5 Completion Record

Date: 2026-08-05
Status: Complete
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

## Credential rotation completion

A replacement OpenAI runtime key was delivered through the GitHub Actions secret named `RUNTIME`, validated with the tunnel client, installed on the VPS, and loaded by a controlled tunnel restart.

- Rotation workflow result: success.
- Restarted tunnel process: PID `128833`, active from `2026-08-05 05:28:48 UTC`.
- Post-rotation local Phase 5 validation: passed.
- Post-rotation live remote `sezu.health`: passed; request `0dec6051-fea3-406a-9c4e-b4cd1034a9a4`.
- Live-rotation installer support was committed at `3eafd3840cbcdfa214275bb69007979898102d3b`.

The superseded key remains subject to provider-side revocation because its value appeared in conversation history. No API key value is recorded in this repository.
