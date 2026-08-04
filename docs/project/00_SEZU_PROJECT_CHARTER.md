# SEZU ChatGPT Project Charter

**Status:** Normative ChatGPT Project source  
**Project:** `sezu`  
**Repository:** `StealthEyeLLC/sezu`  
**Default branch:** `main`

## 1. Canonical identity

```text
Project:             sezu
Repository:          StealthEyeLLC/sezu
Product:             sezu
Command:             sezu
Public MCP tool:     call_sezu
Operation namespace: sezu.*
Protocol:            SEZU1/1.0.0
```

Never introduce `se-z-u` as the product name. Baby and `se-z` are construction-path history only and may not become SEZU runtime dependencies.

## 2. Source authority

1. The user's latest explicit instruction.
2. `SEZU_FINAL_ENGINEERING_SPEC.md`.
3. This charter.
4. `01_SEZU_EXECUTION_DIRECTIVE.md`.
5. `02_SEZU_TURN_FAILURE_RESILIENCE.md`.
6. `03_SEZU_PHASE_PROMPT_STANDARD.md`.
7. Actual repository and live-system state.

The engineering specification is the complete product contract. The other project documents govern how ChatGPT works; they may not add product features.

## 3. Governing rules

- Execute assigned work directly when the connected tools permit it.
- Keep the exact SEZU identity uniform everywhere.
- Preserve unrestricted owner control and arbitrary root execution.
- Add only features explicitly present in the engineering specification or explicitly approved by the owner.
- Prefer the simpler working design with fewer permanent components.
- Use ordinary direct functional commands to establish that work functions.
- Do not create nonfunctional governance or ceremony layers, dashboards, policy engines, approval flows, automatic rollback, or extra permanent services.
- Do not import legacy requirements from `se-z-u`, `se-z`, Baby, archived planners, or earlier assistant proposals.

## 4. Approved expanded scope

The canonical specification now includes reusable skills, workspaces, macros, capability packs, arbitrary named terminals, persistent browser profiles, resumable and cross-target transfer, disposable task cells, broad native Incus control, additional stable language ecosystems, WebAssembly, cross-platform builds, notebooks/data, document/OCR, media/graphics/3D, network/protocol work, machine-image construction, cloud clients, non-Android binary/firmware work, process control, storage control, and on-demand service cells.

Local models and Android tooling are excluded.

## 5. Change rule

Do not silently rewrite the specification. A change requires the owner's explicit instruction or a necessary correction to a proven upstream fact. Keep corrections narrow and update every affected source together.
