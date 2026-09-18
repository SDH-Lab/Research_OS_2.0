# Changing project direction

A rebaseline publishes the researcher's approved objective, research question, completion criteria, scope, resume point and every unfinished Action's disposition together. It writes a Decision record with the named approver, reason, old/new values and task choices. The caller must supply an actual human decision; the command does not infer approval from ongoing work.

Run `research-os project rebaseline --project <vault> --change '<JSON>'` with this structure:

```json
{
  "approvedBy": "Researcher name",
  "reason": "Prioritize pipeline validation and report delivery.",
  "foregroundObjective": "Validate pipeline for report delivery.",
  "driver": {
    "id": "RQ-001",
    "question": "Is pipeline ready for report validation?",
    "closureConditions": ["Validation results accepted."]
  },
  "plan": {
    "completionConditions": ["Report package accepted."],
    "scope": ["Pipeline validation"],
    "outOfScope": ["ExampleModel ablations"],
    "resumePoint": {
      "last_verified_point": "Report direction approved.",
      "next_action": "Validate the report package.",
      "next_command_or_edit": null,
      "required_files": ["PROJECT.md", "plans/active.md"],
      "risks": [],
      "reforecast_trigger": null
    }
  },
  "actions": [
    {"id": "ACT-001", "disposition": "keep"},
    {"id": "ACT-002", "disposition": "cancel"},
    {"id": "ACT-003", "disposition": "defer"},
    {"id": "ACT-004", "disposition": "supersede", "replacement": "ACT-001"}
  ]
}
```

The Driver and replacement Actions must already exist. Include every Action whose status is neither closed, cancelled nor superseded. `keep` preserves its current state, including an existing deferral; `defer`, `cancel` and `supersede` set distinct non-success states. A superseded Action needs a retained, scheduled replacement. Active background work must be received or released before its Action is retired. Historic blockers are preserved, rather than falsely marked resolved.

Only `PROJECT.md` defines the current objective. The active plan refers to that authority. Historical experiments, manifests, runs, results and evidence retain their original bytes. The result reports whether each existing Manifest still matches current resource authority. An objective-only change does not change the Manifest resource snapshot; official receipts binding the Project file require rechecking against its new bytes. Neither receipts nor historical evidence are rewritten.

The command validates proposed records before publication, checks exact input snapshots and holds a single publication journal. A write failure restores original bytes. While a journal exists, authority readers refuse incomplete state. If the process was interrupted, run `research-os project recover --project <vault>` to restore the prior state, then retry the approved operation. Recovery refuses live writers and unrelated edits made after interruption; it preserves those files and reports the conflict. This is project-local transaction recovery, not a project-format migration mechanism.
