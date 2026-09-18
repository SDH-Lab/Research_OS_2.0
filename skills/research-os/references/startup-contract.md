# Startup contract

This contract applies to work inside a research Project Vault. Core source development follows its repository instructions without requiring a Vault.

## Locate and diagnose

Use the task's known Vault root or the nearest ancestor containing regular `AGENTS.md` and `PROJECT.md` files. Do not search unrelated home directories. If the task requires a Vault and its location remains unknown, identify that missing input without blocking unrelated authorized work.

```bash
research-os doctor --project "$VAULT_ROOT"
research-os project setup-status --project "$VAULT_ROOT"
research-os session context --project "$VAULT_ROOT"
```

Commands must return documented JSON and exit status. Missing or silent commands, version mismatch, unsafe paths, malformed authority, or an ambiguous Active Plan block dependent project writes. Incomplete setup follows [setup-handshake.md](setup-handshake.md), reusing already established user decisions.

## Recover only current work

From session context recover `foregroundObjective`, `actions`, `attention`, `nextAction`, `blockers`, `writablePaths`, `authoritativeSources`, and `resumePoint`. Read only current authority and required files. `latestCheckpoint` is a pointer for optional investigation, not an instruction to load the whole history chain.

The project objective has one source in `PROJECT.md`. The Active Plan holds current controls and next step; Action records hold validation plans, existing approval grants, evidence, and blocker history. Historical checkpoint entries live in `plans/logs/`.

Briefly report objective, next action, blockers, write scope, files read, and decisions that are actually missing. Do not ask for authorization again when the same scope has already been approved.

## Preflight and claim

Configure an unconfigured Action's candidate version, necessary checks, attempt limits and operation scope. Record a grant only from actual user authorization.

```bash
research-os session preflight --project "$VAULT_ROOT" --claim '<JSON>'
research-os action claim --project "$VAULT_ROOT" --id ACT-001
```

The preflight JSON contains `actionId`, `dependencies`, `resources`, `writablePaths`, and `unknowns`. Resource execution requires a fresh actual `--observation` JSON. Proceed only when the relevant checks allow it. Preflight itself is read-only; claim persists execution state. A block is a concrete task issue to resolve, not permission to change scientific scope or bypass platform permissions.

## Stop and hand off

Necessary checks passing means stop checking and present the candidate for acceptance. Record the actual acceptance before closing. If the agreed attempts fail, record the cause and a reasoned revision, narrowed task, or pause; never silently reset a budget.

```bash
research-os record validate --project "$VAULT_ROOT"
research-os session checkpoint --project "$VAULT_ROOT" --update '<JSON>'
```

The update contains factual `progress`, `artifacts`, `discoveries`, `decisions`, and `resumePoint`. Logs preserve historical facts; Active Plan updates only current recovery state and the history pointer. Never record intended work as completed. Identify uncommitted project records without implying a checkpoint committed them.
