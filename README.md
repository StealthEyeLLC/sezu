# SEZU

SEZU is an owner-controlled, standalone, unrestricted root execution system for `StealthEyeLLC/sezu`.

Canonical identity:

```text
Product:             sezu
Command:             sezu
Public MCP tool:     call_sezu
Operation namespace: sezu.*
Wire protocol:       SEZU1/1.0.0
Default branch:      main
```

SEZU gives ChatGPT and other authorized MCP clients direct control of the Ubuntu host, the privileged Incus system container `u`, additional containers and VMs, durable jobs, reconnectable terminals, unrestricted files and artifacts, reusable skills, persistent browser profiles, workspaces, capability packs, service templates, and native Incus resources.

The build remains seven phases (`0` through `6`), uses exactly one public MCP tool, and adds no approval system, command policy, audit framework, evidence subsystem, report generator, mandatory rehearsal, automatic rollback, or public MCP listener.

## Canonical documents

1. [`SEZU_FINAL_ENGINEERING_SPEC.md`](SEZU_FINAL_ENGINEERING_SPEC.md) - complete product and build contract.
2. [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) - the seven-phase implementation map.
3. [`docs/OPERATION_CATALOG.md`](docs/OPERATION_CATALOG.md) - the native `sezu.*` operation surface.
4. [`docs/CAPABILITY_PACKS.md`](docs/CAPABILITY_PACKS.md) - installed and on-demand forge abilities.
5. [`docs/project/`](docs/project/) - the exact ChatGPT Project source documents.

## Build rule

Phase 0 resolves every moving upstream input into exact stable versions, immutable URLs, package locks, and digests. Later phases consume only those committed locks. Alpha, beta, release-candidate, nightly, moving-branch, and `latest` inputs are excluded.
