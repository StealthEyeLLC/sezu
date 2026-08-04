# SEZU Phase Prompt Standard

**Status:** Normative ChatGPT Project source

Every substantive SEZU execution prompt must contain these elements without inventing additional product requirements.

## 1. Source bootstrap

Require the executing tab to read all five ChatGPT Project source documents and inspect the actual repository and relevant live state before acting.

## 2. Canonical identity

```text
Repository: StealthEyeLLC/sezu
Product:    sezu
Command:    sezu
MCP tool:   call_sezu
Namespace:  sezu.*
Protocol:   SEZU1/1.0.0
```

## 3. Exact mission

Name the phase or task and the concrete outcome required by `SEZU_FINAL_ENGINEERING_SPEC.md` or the owner's latest instruction.

## 4. Scope boundary

List what the task includes and which later-phase work it must not begin. Do not import archived requirements.

## 5. Continuous execution

State that the tab owns the complete assigned scope and must not stop at planning, scaffolding, a running job, a failed command, a local commit, or a progress message.

## 6. Direct function checks

Require only the ordinary commands needed to establish that the implemented capability works. Do not add unrelated product machinery.

## 7. Repository completion

For repository-changing work, require coherent commits and a push to the intended branch. For live work, require the actual target capability to work and temporary state to be cleaned up.

## 8. Anti-expansion rule

The engineering specification is the complete product contract. Do not add approval systems, command policy, nonfunctional governance or ceremony layers, automatic snapshots or rollback, local models, Android tooling, public MCP ingress, or extra phases.
