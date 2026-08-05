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


## Local runtime

Phase 4 installs the immutable `0.1.0` release at `/opt/sezu/releases/0.1.0` and points `/opt/sezu/current` to it. The enabled root supervisor owns `/run/sezu/supervisor.sock`; both the local `sezu` command and the unprivileged direct-stdio gateway submit requests through that socket.

```bash
sezu --version
sezu sezu.health --json
sezu sezu.exec --target u --args-json '{"argv":["/usr/bin/id"]}' --json
sezu sezu.exec --target host --args-json '{"argv":["/usr/bin/id"]}' --json
```

The gateway executable is `/usr/local/bin/sezu-gateway` and exposes exactly one MCP tool, `call_sezu`, over stdin/stdout. `sezu-tunnel.service` is installed for Phase 5 but remains disabled and inactive until real tunnel credentials are supplied. No TCP or HTTP listener is part of the Phase 4 runtime.

The direct installed-state check is:

```bash
/opt/sezu/current/scripts/phase4-sezu-check.sh
```

## Outbound tunnel

Phase 5 keeps credentials outside the repository and activates the existing
outbound-only service. Generate the production YAML from the real tunnel ID
and a securely created runtime-key file, then run the direct local check:

```bash
sudo scripts/phase5-tunnel-apply.sh \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --runtime-key-file /secure/path/sezu-runtime-key
sudo scripts/phase5-tunnel-check.sh
```

The service uses `/run/sezu/tunnel-health.sock`, launches the installed stdio
gateway on channel `sezu`, and exposes only `call_sezu`. The repository example
at `config/tunnel/tunnel-client.example.yaml` contains no credential.
