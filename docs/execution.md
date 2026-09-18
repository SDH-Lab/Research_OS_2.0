# Accepted artifacts and execution readiness

An Action can depend on `ART-001` in its existing `dependencies` array. The Artifact identifies one exact file version, its producer Action, its SHA-256 digest, and the actor, time, and evidence of acceptance. The producer can remain `in_progress` while downstream work uses the accepted file.

Create an Artifact with the ordinary record command:

```sh
research-os record new --type artifact --project "$VAULT" --id ART-001 --title "Checked model" --values '{"producer_action":"ACT-001","file":"outputs/ACT-001/model.bin"}'
```

Advance the candidate through the ordinary lifecycle to `review`, then explicitly accept it:

```sh
research-os artifact accept --project "$VAULT" --id ART-001 --acceptance '{"actor":"researcher","evidence":"Held-out evaluation and checkpoint provenance checked."}'
```

Acceptance atomically records `review → verified → closed`, binding the actual file bytes to the decision. It does not close the producer Action or accept a scientific claim. The file must be within the producer's declared operation scope. Dependencies reject an unaccepted, missing, or changed file. A changed model needs a new Artifact ID; accepted IDs cannot be reopened to point at another version.

## Exact resource lanes

Use the existing `PROJECT.resources` registration for each concrete lane, such as `gpu0` and `gpu1`, with its existing server URI and `role: compute`. Input resources such as read-only data remain ordinary approved references and are not exclusive execution lanes. Define the Action's execution requirements at creation:

```json
{
  "execution": {
    "resources": ["gpu1"],
    "writable_paths": ["outputs/ACT-002/**"],
    "resource_observation": null
  }
}
```

These paths and resource names must fit the Action's approved `operation_scope`, and its writes must fit the Active Plan's `writable_paths`. Existing authorization, validation budgets, unresolved blockers, dependencies, and writer conflicts remain binding.

After checking the actual server with the project's existing execution method, claim the exact lanes:

```sh
research-os action claim --project "$VAULT" --id ACT-002 --observation '{"observed_at":"2026-09-18T09:30:00Z","source":"ssh server nvidia-smi","available":["gpu1"]}'
```

Use the real current observation time. A resource claim requires a newly supplied observation from after the latest Action update; it cannot reuse the stored observation. Only the requested lanes must be available. A busy `gpu0` does not prevent a claim on available `gpu1`. An Action without resource requirements needs no observation.

Claiming atomically checks current dependencies, accepted file digests, authority snapshots, competing Action claims, and registered writers before setting the Action to `in_progress`. Simultaneous claims on one lane cannot both succeed. The recorded observation is evidence from the existing server check; this command does not probe a remote server or launch a job.

```sh
research-os action ready --project "$VAULT"
```

The `runnable`, `active`, and `waiting` lists are derived from canonical Actions. An `in_progress` Action owns its declared lanes and write scopes until it leaves that status; changing the Action's lifecycle releases that allocation. This is a project record of execution, not an external scheduler reservation. A waiting resource Action without an observation can be claimed directly after a fresh server check. Artifact acceptance and execution claims use the shared transaction guard and stop if a project update needs recovery.
