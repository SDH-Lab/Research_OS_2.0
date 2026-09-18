# Bounded Action workflow

An Action may be drafted without workflow settings. Before starting it, configure the current candidate, the necessary checks and their attempt limits, and the exact approved operation scope. No global attempt budget is imposed.

```js
await configureAction(root, 'ACT-001', {
  candidate_version: 'report-2026-09-18-v1',
  validation_plan: {
    tier: 'presentation',
    checks: [{
      id: 'render',
      description: 'Inspect the rendered table for truncation and correct units.',
      max_attempts: 2
    }]
  },
  operation_scope: {
    operations: ['edit-report'],
    paths: ['writing/report.md'],
    resources: []
  }
});
await approveActionScope(root, 'ACT-001', {
  grant_id: 'GRANT-001', approver: 'researcher',
  reason: 'The researcher requested this report correction.'
});
```

The tiers describe the necessary evidence:

- `scientific`: data, training, evaluation, or scientific conclusions require relevant semantic checks, real inputs, and traceable result sources.
- `implementation`: check the affected behavior and a small complete execution path.
- `presentation`: inspect the affected text or display. A change to numerical meaning requires the scientific or implementation tier appropriate to that change.

The researcher or agent chooses the actual check descriptions and attempt limits for the task. The system does not infer scientific sufficiency from a tier label.

`recordActionCheck(root, id, {check_id, candidate_version, outcome, evidence})` records a real `pass` or `fail` for a declared check. The evidence must identify what was inspected or executed. A passed check cannot be repeated for the same candidate. Exhausting a check's agreed attempts creates one active validation blocker, and additional attempts are rejected.

Use `configureAction` with a `reason` to record a changed candidate, criteria, scope, or attempt limit. Increasing an attempt limit retains earlier attempts. Changing the candidate preserves old check evidence and the old plan in `validation_revisions`; a previous candidate identifier cannot be reused. The new plan contains the checks required for the current change, so an isolated revision need only check affected behavior. Select those checks explicitly. Changed scientific inputs or protocols require the corresponding scientific checks; changing the label alone does not establish their validity. An explicit candidate revision or increased budget resolves the matching exhaustion blocker with the recorded reason. Other active blockers remain active.

Scope approvals record their grant identifier, approver, reason, timestamp, and exact operations, paths, and resources. Order does not affect scope comparison. Existing approval remains valid within the same scope; a changed scope needs a matching approval. A grant identifier cannot be reused for different scope or a different approver. These records do not replace operating system or execution platform permissions.

Execution resource names and write patterns are declared separately in `execution`; the Action template initializes empty lists and a null resource observation. Execution and preflight check those claims against the approved operation scope and available resources.

Create a blocker through `recordActionBlocker(root, id, {operation:'create', id, category, description, owner, since, next_unblock_action, review_at, root_cause, critical_path})`. Categories are `approval`, `network`, `resource`, `implementation`, `validation`, `dependency`, and `other`. Use `null` for unknown `since` or `review_at` rather than estimating missing history. Resolve it with `{operation:'resolve', id, resolution, resolved_at}`. Omit `resolved_at` to record the current time, or use `null` when the historical resolution time is unknown. Resolved entries and their original causes remain in the Action.

All checks passing means the candidate is ready for acceptance. It does not establish an accepted scientific conclusion or close the Action. Status transitions use explicit human acceptance stored as `validation_acceptance: {candidate_version, accepted_by, accepted_at, reason}`. `assertActionCanClose(attributes)` requires passing checks for that candidate, matching scope approval, no active blockers, and valid acceptance. Revising the workflow clears its previous acceptance.

The module exports `configureAction`, `recordActionCheck`, `approveActionScope`, `recordActionBlocker`, `inspectActionWorkflow`, `assertActionCanStart`, and `assertActionCanClose`. Mutations return a frozen `{id, type, path, attributes}` record reference. Inspection and assertions take Action attributes directly. Mutations preserve the Markdown body and validate the complete record before writing atomically.
