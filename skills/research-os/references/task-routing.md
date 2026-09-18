# Task routing

First run:

```bash
research-os guide locate
```

Use the returned `guideIndex` to derive sibling chapter paths. Never guess a package checkout, persist that absolute path in the Vault, or copy the full guide into context. Read the index plus only the chapters needed for the current Action.

| Current task | Read these guide chapters |
| --- | --- |
| First setup, authority model, record layout | `01-installation-and-first-project.md`, `02-mental-model-and-authority.md`, `03-layout-records-and-links.md` |
| Daily work, rebaseline, interruption, execution resources or Agent coordination | `04-daily-weekly-and-disruption.md`, `05-sessions-agents-and-handoffs.md` |
| Experiment design, run, result, provenance, validation | `06-experiment-workflow.md`, `08-validation-and-human-gates.md` |
| Manuscript, reviewer response, evidence-to-writing | `07-writing-and-response.md`, `08-validation-and-human-gates.md` |
| Progress, WIP, blockers, forecast | `09-dashboard-and-forecast.md` |
| Diagnosis, backup, repair, CLI/schema lookup | `10-maintenance-troubleshooting-and-backup.md`, `12-cli-and-schema-reference.md` |
| Core release format or upgrade | `11-core-upgrades-and-migrations.md` |
| Executable examples after choosing a workflow | `13-recipes.md` |

When a task spans rows, read the smallest union. Return to the index if the Action changes; do not preload future domains.
