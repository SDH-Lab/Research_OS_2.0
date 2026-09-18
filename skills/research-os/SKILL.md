---
name: research-os
description: Use when opening, resuming, auditing, or changing a Research OS Project Vault, when AGENTS.md names $research-os, or when maintaining Research OS Core source and its workflow rules.
---

# Research OS

## Locate the work

For a research project, locate its `AGENTS.md` and `PROJECT.md`. Read [startup-contract.md](references/startup-contract.md), then run `doctor`, `project setup-status`, and `session context` against that Vault. If the task is maintaining Research OS Core source, follow the repository instructions and the user's development scope; a Project Vault is not required and must not be invented.

## Recover current authority

Treat `PROJECT.md.foreground_objective` as the single project objective. Recover active Actions, blockers, existing grants, writable paths, and the exact next step. Read only current `authoritativeSources` and necessary `resumePoint.requiredFiles`. The Active Plan contains current controls; `latest_checkpoint` points to history under `plans/logs/`. Read a historical log only when the current task needs its evidence. Do not preload completed tasks, full history, or the full guide.

Report the objective, next action, blockers, writable scope, authority actually read, and any missing decisions briefly. Missing authority, failing capability/version checks, or incomplete project setup block dependent project writes. Continue independent authorized work where possible. Use [setup-handshake.md](references/setup-handshake.md) for genuinely missing setup decisions.

If current deliverables and evidence show a different direction from the saved objective, explain the mismatch with concrete evidence and propose a project rebaseline. Reuse an existing decision when it already authorizes the change; otherwise obtain the researcher's choice before retiring research work. Apply the objective, question, plan, and explicit task dispositions together with `project rebaseline`.

## Execute within authorization

Before starting an Action, configure its candidate version, risk tier, necessary checks, per-check attempt limits, and exact operations, paths, and resources. Record actual user authorization and reuse it while scope is unchanged, including across sessions. Never fabricate an approver or ask again merely because a new session began. Changed scope requires the relevant new decision. Saved grants do not bypass platform permissions.

Run preflight for the exact Action, dependencies, resources, write scope, and unknowns. Use Action claims and current resource observations for execution. Downstream work may depend on an accepted exact Artifact version while its producer remains open. Unaccepted or changed artifacts remain blocked.

Record blockers and resolutions in the owning Action with stable IDs, cause, critical-path impact, and known timestamps; use null for unknown historical times. Preserve resolved history.

## Stop, accept, and hand off

Run the agreed necessary checks. Stop when they pass; do not add arbitrary review rounds. Exhaustion requires a recorded reasoned decision to revise, narrow, or pause. Changes reopen only the checks affected by the new candidate or criteria.

Present actual evidence for acceptance. Execution completion does not approve scientific meaning, Claims, or delivery. On real acceptance, update status and the next step promptly; credible negative results can complete work.

Validate changed authority and checkpoint factual progress, artifacts, discoveries, decisions, and the current resume point. History goes to logs, not growing Active Plan lists. Report uncommitted project records; checkpointing is not a Git commit.

Use [task-routing.md](references/task-routing.md) to load only the guide chapters needed now.
