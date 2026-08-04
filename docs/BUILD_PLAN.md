# SEZU Seven-Phase Build Plan

This file maps the expanded capability contract into the existing phases. It does not add phases.

| Phase | Existing purpose | Added scope |
|---|---|---|
| 0 | Freeze inputs | Resolve and lock capability packs, service images, schemas, skills, browser assets, and direct artifacts |
| 1 | Host base | No new product subsystem; only paths and prerequisites used by expanded SEZU |
| 2 | Network and Incus | Full Incus resources, remotes, migration, DNS/forwards, template structure, task/service cells |
| 3 | Build `u` | Default packs, profile storage, Jupyter/data, documents/OCR, WebAssembly, network tools, cross-build and image tools; cache on-demand packs |
| 4 | Install SEZU | Skills, workspaces, macros, packs, arbitrary terminals, browser profiles, resumable/cross-target transfer, process control, expanded Incus operations |
| 5 | Tunnel | Unchanged: outbound tunnel and one `call_sezu` tool |
| 6 | Finished-system use | Direct functional use of each capability family; no separate reporting or evidence system |

## Phase boundaries

- Phase 0 may retrieve sources and generate locks but does not install SEZU on the live host.
- Phase 1 prepares the host but does not build `u` or install the SEZU runtime.
- Phase 2 creates networking and Incus objects but does not populate the forge.
- Phase 3 builds the forge image and capability-pack inputs but does not activate the tunnel.
- Phase 4 installs all local SEZU functionality.
- Phase 5 activates the independent outbound tunnel.
- Phase 6 uses the system end to end and repairs actual defects.

## Permanent-service rule

The upgrade set adds no permanent host service. The intended host service set remains:

```text
sezu-supervisor.service
sezu-tunnel.service
```

Docker remains inside `u`. Jupyter, browsers, databases, brokers, cloud clients, reverse-engineering tools, and service templates run only when requested.
