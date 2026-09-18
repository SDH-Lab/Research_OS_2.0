# Setup handshake

Use this only when `project setup-status` reports `configured: false` or a human-review item is not confirmed.

## Proposal

Inspect the Vault and only the resources already placed in scope. Produce a proposal table with:

- field and exact authority location;
- proposed value;
- source path or explicit user statement;
- confidence and unresolved alternatives;
- whether human approval is mandatory.

Cover the project objective and completion condition, in/out of scope, first Action and acceptance, writable paths, timezone and capacity, resources and access, applicable modules, approved code roots, and canonical writing sources. Use `not applicable` only with a stated reason.

## Review

Reuse explicit user decisions already provided for this scope. Ask only for decisions that are actually missing or materially changed, presenting the concrete proposal and remaining choice. Discovery is not approval. Never infer approval from silence or from an existing file path.

The human owns scientific meaning, scope, Claims, experiment intent and evaluation semantics, write permission, code-root approval, canonical writing sources, and delivery decisions.

## Apply

Once explicit approval already exists or has been supplied:

1. change only approved fields in their canonical authority files;
2. show the exact diff;
3. run `record validate` and `doctor`; stop if either reports an error;
4. transition `PLN-001` to `ready` first, then `PRJ-001` to `ready`, each with a reason stating that the human reviewed the setup authority;
5. rerun `record validate`, `doctor`, `project setup-status`, and `session context`.

If validation fails, report exact fields and fix authorized mechanical defects. Keep unresolved scientific decisions explicit; do not invent values, broaden scope, or mark incomplete setup complete.
