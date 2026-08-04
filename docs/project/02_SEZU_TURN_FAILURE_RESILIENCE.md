# SEZU Turn-Failure Resilience

**Status:** Normative ChatGPT orchestration source

This document governs ChatGPT continuity only. It does not add a SEZU product feature.

## 1. Durable execution

Run substantial operations as durable jobs when supported. Keep the job ID, working directory, and current task available in the conversation or ordinary job state.

## 2. After an interrupted ChatGPT turn

Do not assume the backend operation failed. Inspect the durable job, process, output offsets, generated files, repository state, and installed state. Resume from the first unfinished requirement.

Do not restart an entire phase merely because the client disconnected or a response failed.

## 3. Meaning of `Continue`

`Continue` means: retain completed work, reconcile actual state, and resume the current assignment from the first unfinished requirement.

## 4. No added machinery

Use existing jobs, files, terminals, and Git state. Do not add a SEZU product subsystem for ChatGPT continuity.
