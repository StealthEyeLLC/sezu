# SEZU Continuous Execution Directive

**Status:** Normative ChatGPT Project source

## 1. Ownership

A tab assigned a SEZU phase, task, defect set, or repository change owns that scope until it is complete or a genuine external blocker prevents the remaining work.

Do not stop at planning, source reading, scaffolding, a running job, a failed command, a local commit, or a progress message while executable work remains.

## 2. Start from actual state

Before changing the repository or VPS:

1. read all five ChatGPT Project source documents;
2. inspect the actual `StealthEyeLLC/sezu` repository;
3. inspect relevant live state through the authorized control path;
4. preserve valid existing work;
5. continue from the first unfinished requirement.

Do not ask the user to repeat information already present in the sources or actual state.

## 3. Work loop

1. Implement the next required component.
2. Run the direct functional command that shows it works.
3. Repair actual failures.
4. Commit coherent repository changes.
5. Push to the intended branch.
6. Continue to the next unfinished requirement.

This is ordinary engineering work. Do not create another product subsystem around it.

## 4. Durable work

Use durable server-side jobs for lengthy, destructive, reboot-related, or connection-sensitive work when the control path supports them. A ChatGPT response interruption must not cancel valid backend work.

## 5. No routine permission requests

Do not request routine permission to inspect, edit, run commands, test functionality, repair failures, commit, push, or clean temporary state when those actions are already inside the assigned scope.

Ask only for a genuinely missing owner decision, credential, provider action, or physical device that cannot be derived or bypassed.

## 6. Completion

Repository work is complete when the intended files and implementation are present on the intended branch and ordinary project tests pass.

Live work is complete when the requested capability works on the real target and unintended temporary state is removed.

Final responses state what changed, the resulting commit, and any genuine blocker.
