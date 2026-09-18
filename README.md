# Research_OS_2.0
**Keep your research connected and focused.**

As a project grows, goals, experiments, and decisions get scattered across files and conversations. Research OS connects them so you and your agent can focus on what matters—and trace problems back to the files that explain them.

## Why use it?

- **Resume without retelling everything.** Keep the current goal, blockers, and next step ready for the next session.
- **Trace conclusions to results.** Connect claims to experiments and specific file versions.
- **Change direction without losing context.** Record what changed, why, and which tasks still matter.

Codex does the work. Research OS keeps the project record. You make the research decisions.

Everything stays in Markdown and YAML. Open it in your editor or Obsidian—no database or server needed.

## Get started

Requires **Node.js 20+**, npm, and Codex.

Clone or download this repository, then run these commands from its folder:

```bash
npm ci
npm link
research-os skill install --target "${CODEX_HOME:-$HOME/.codex}/skills"
```

Create a project outside the source repository:

```bash
research-os project init \
  --target ../my-research \
  --id my-research \
  --title "My Research" \
  --stage research
```

Open `../my-research` in a new Codex session and say:

> Use $research-os to set up this project. Help me define the research goal, what counts as done, and the resources and permissions needed to begin.

Initialization creates a starter folder. This conversation completes the setup.

## Use it every day

Start a session:

> Use $research-os to resume this project and continue the next task.

Change direction:

> Our goal has changed to […]. Update the plan and identify which tasks are still useful.

Wrap up:

> Record the results, link the supporting evidence, and save a clear next step.

## Try the demo

From the repository folder:

```bash
node scripts/demo-workflow.js
```

The demo uses synthetic data in a temporary project.

## Learn more

[User guide (Chinese)](docs/user-guide/README.md) · [Task workflow](docs/action-workflow.md) · [Changing goals](docs/rebaseline.md)

Research OS checks project records and workflow consistency. Scientific conclusions still need your judgment.
