import { configureAction, approveActionScope, recordActionCheck } from '../../src/actions/workflow.js';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { initProject } from '../../src/project/project.js';
import { createRecord, updateRecordStatus } from '../../src/records/create.js';

export function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'research-os-'));
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function makeProjectFixture(overrides = {}) {
  const root = join(await makeTempDir(), 'vault');
  await initProject({
    targetDir: root,
    projectId: 'demo',
    title: 'Demo',
    stage: 'research',
    coreRoot: join(process.cwd(), 'core'),
    ...overrides
  });
  return root;
}

export async function makeCandidateCoreFixture(version = '2.1.0', mutate = async () => {}) {
  const root = join(await makeTempDir(), 'candidate-core');
  await cp(join(process.cwd(), 'core'), root, { recursive: true });
  await writeFile(join(root, 'VERSION'), `${version}\n`, 'utf8');
  const projectSchemaPath = join(root, 'schemas', 'project.schema.json');
  const projectSchema = JSON.parse(await readFile(projectSchemaPath, 'utf8'));
  projectSchema.allOf[1].properties.core_version.const = version;
  await writeFile(projectSchemaPath, `${JSON.stringify(projectSchema, null, 2)}\n`, 'utf8');
  await mutate(root);
  return root;
}

export async function configureSessionFixture(root, overrides = {}) {
  const projectPath = join(root, 'PROJECT.md');
  const planPath = join(root, 'plans', 'active.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  const plan = parseMarkdownDocument(await readFile(planPath, 'utf8'), planPath);
  const objective = overrides.objective ?? 'Close ACT-001 with checked evidence.';
  const resumePoint = overrides.resumePoint ?? {
    last_verified_point: 'Project initialized.',
    next_action: 'Claim ACT-001 and inspect its inputs.',
    next_command_or_edit: 'research-os session preflight',
    required_files: ['PROJECT.md', 'plans/active.md', 'plans/actions/ACT-001.md'],
    risks: [],
    reforecast_trigger: null
  };
  await writeFile(projectPath, serializeMarkdownDocument({
    ...project.attributes,
    foreground_objective: objective,
    resources: overrides.resources ?? project.attributes.resources,
    ...(overrides.project ?? {})
  }, project.body), 'utf8');
  await writeFile(planPath, serializeMarkdownDocument({
    ...plan.attributes,
    writable_paths: ['plans/actions/ACT-001.md'],
    resume_point: resumePoint,
    ...(overrides.plan ?? {})
  }, plan.body), 'utf8');
}

export async function makeReadyActionFixture(root, overrides = {}) {
  const id = overrides.id ?? 'ACT-001';
  await createRecord(root, 'driver', {
    id: overrides.driver ?? 'RQ-001', title: 'Session driver', source: 'brief', question: 'What should this Session close?'
  });
  await createRecord(root, 'action', {
    id,
    title: 'Session action',
    driver: overrides.driver ?? 'RQ-001',
    dependencies: overrides.dependencies ?? [],
    acceptance: 'The registered Artifact is checked.',
    execution: { resources: [], writable_paths: [`plans/actions/${id}.md`], resource_observation: null },
    ...overrides.values
  });
  await configureAction(root, id, { candidate_version: 'fixture-v1', validation_plan: { tier: 'implementation', checks: [{ id: 'acceptance', description: 'Inspect the fixture Artifact.', max_attempts: 2 }] }, operation_scope: { operations: ['execute'], paths: ['**', 'PROJECT.md', 'plans/active.md'], resources: ['data', 'results', 'code'] } });
  await approveActionScope(root, id, { grant_id: 'fixture-grant', approver: 'fixture-researcher', reason: 'Test fixture scope approved.' });
  await updateRecordStatus(root, id, 'defined', { reason: 'Action defined.' });
  await updateRecordStatus(root, id, 'ready', { reason: 'Inputs and acceptance checked.' });
  return id;
}

export async function writeRecordFixture(root, relativePath, attributes, body = '# Record\n') {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, serializeMarkdownDocument(attributes, body), 'utf8');
  return path;
}

export function projectConfigAt(root = '/tmp/research-os-project', overrides = {}) {
  return { root, configPath: `${root}/research-os.yml`, ...overrides };
}

export function resourceProject(root = '/tmp/research-os-project', overrides = {}) {
  return {
    ...projectConfigAt(root),
    resources: {
      experiment_results: { uri: root, role: 'experiment-results', access: 'read-only' },
      code: { uri: 'ssh://research.example.org/worktrees/project', role: 'implementation', access: 'read-write' }
    },
    approved_code_roots: ['code'],
    ...overrides
  };
}

export function validContract(overrides = {}) {
  const manifest = validManifest();
  return {
    id: 'EXP-CONTRACT-001',
    version: '2.0.0',
    approved_use: 'official baseline evidence',
    requirements: {
      code_root: manifest.code_root,
      resolved_code_root: manifest.resolved_code_root,
      entrypoint: manifest.entrypoint,
      commit: manifest.commit,
      resolved_config: manifest.resolved_config,
      data_and_split: manifest.data_and_split,
      model_and_checkpoint: manifest.model_and_checkpoint,
      training_boundary: manifest.training_boundary,
      optimizer_scheduler: manifest.optimizer_scheduler,
      evaluator: manifest.evaluator,
      command: manifest.command,
      environment: manifest.environment,
      output_location: manifest.output_location,
      expected_artifacts: manifest.expected_artifacts
    },
    semantic_checks: [
      { name: 'split identity', field: 'data_and_split.split_function', required: 'heldout-v1', evidence: 'Approved Experiment Package', risk: 'Leakage if a different split is used.' }
    ],
    allowed_deviations: [],
    ...overrides
  };
}

export function validExperimentProject(overrides = {}) {
  return {
    project_id: 'demo',
    core_version: '2.0.0',
    approved_code_roots: ['sample_code'],
    resources: {
      sample_code: { uri: 'ssh://research.example.org/worktrees/sample_code', role: 'implementation', access: 'read-only', identity: 'sample-v1' },
      data: { uri: 'ssh://research.example.org/data', role: 'input-data', access: 'read-only', identity: 'data-v1' },
      models: { uri: 'ssh://research.example.org/models', role: 'model-input', access: 'read-only', identity: 'models-v1' },
      experiment_results: { uri: 'ssh://research.example.org/results', role: 'experiment-results', access: 'read-write', identity: 'results-v1' }
    },
    ...overrides
  };
}

export function validManifest(overrides = {}) {
  const codeRoot = overrides.code_root ?? 'sample_code';
  return {
    code_root: codeRoot,
    resolved_code_root: overrides.resolved_code_root ?? { resource: codeRoot, uri: `ssh://research.example.org/worktrees/${codeRoot}`, identity: `${codeRoot === 'sample_code' ? 'sample' : codeRoot}-v1` },
    entrypoint: 'train.py',
    commit: 'abc1234',
    resolved_config: { seed: 7, batch_size: 16 },
    data_and_split: { dataset_root: 'data:sample-v1', manifest: 'data:manifest.json', split_function: 'heldout-v1', seed: 7, class_or_domain_order: ['healthy', 'disease'] },
    model_and_checkpoint: { model_class: 'ExampleModel', checkpoint: 'models:base-v1.ckpt' },
    training_boundary: { trainable_parameters: ['adapter'], loss: 'cross_entropy', sampler: 'balanced', gradient_accumulation: 1 },
    optimizer_scheduler: {
      optimizer: { name: 'AdamW', parameters: { learning_rate: 0.001 } },
      scheduler: { name: 'cosine', parameters: {} },
      checkpoint_selection: 'best-auroc',
      early_stopping: { mode: 'enabled', monitor: 'auroc', patience: 5 }
    },
    evaluator: { implementation: 'macro-auroc', metrics: ['auroc'], aggregation: 'macro', state: 'eval' },
    command: 'python train.py --config configs/baseline.yaml',
    environment: { runtime: 'python-3.11', packages: { torch: '2.5.0' }, hardware: 'cuda-12.1' },
    output_location: 'experiment_results:EXP-001',
    expected_artifacts: ['experiment_results:EXP-001/metrics.json', 'experiment_results:EXP-001/run.log'],
    ...overrides,
    code_root: codeRoot
  };
}

export function catalogFixture(overrides = {}) {
  return {
    projects: [{ id: 'synthetic-project', title: 'Synthetic Research Project', status: 'active' }],
    ...overrides
  };
}

export function mixedWorkCatalog(overrides = {}) {
  const entries = [
    ['plans/actions/ACT-101.md', {
      id: 'ACT-101', type: 'action', path: 'plans/actions/ACT-101.md', attributes: {
        schema_version: 1, type: 'action', id: 'ACT-101', status: 'in_progress',
        created: '2026-07-20T00:00:00Z', updated: '2026-07-21T00:00:00Z', status_history: [
          { from: 'inbox', to: 'defined', at: '2026-07-20T00:00:01Z', reason: 'defined' },
          { from: 'defined', to: 'ready', at: '2026-07-20T00:00:02Z', reason: 'ready' },
          { from: 'ready', to: 'in_progress', at: '2026-07-21T00:00:00Z', reason: 'started' }
        ],
        driver: 'RQ-001', purpose: 'Run experiment.', inputs: [], outputs: [], dependencies: [],
        acceptance: 'Checked output.', risks: [], writer: 'foreground', next_step: 'Inspect output.',
        domain: 'experiment', size: 'large', blockers: []
      }
    }],
    ['plans/actions/ACT-102.md', {
      id: 'ACT-102', type: 'action', path: 'plans/actions/ACT-102.md', attributes: {
        schema_version: 1, type: 'action', id: 'ACT-102', status: 'ready',
        created: '2026-07-20T00:00:00Z', updated: '2026-07-20T00:00:02Z', status_history: [
          { from: 'inbox', to: 'defined', at: '2026-07-20T00:00:01Z', reason: 'defined' },
          { from: 'defined', to: 'ready', at: '2026-07-20T00:00:02Z', reason: 'ready' }
        ],
        driver: 'RQ-001', purpose: 'Analyse output.', inputs: [], outputs: [], dependencies: ['ACT-101'],
        acceptance: 'Checked analysis.', risks: [], writer: 'foreground', next_step: 'Wait for ACT-101.',
        domain: 'analysis', size: 'medium', blockers: []
      }
    }],
    ['plans/actions/ACT-103.md', {
      id: 'ACT-103', type: 'action', path: 'plans/actions/ACT-103.md', attributes: {
        schema_version: 1, type: 'action', id: 'ACT-103', status: 'ready',
        created: '2026-07-20T00:00:00Z', updated: '2026-07-20T00:00:02Z', status_history: [
          { from: 'inbox', to: 'defined', at: '2026-07-20T00:00:01Z', reason: 'defined' },
          { from: 'defined', to: 'ready', at: '2026-07-20T00:00:02Z', reason: 'ready' }
        ],
        driver: 'RQ-001', purpose: 'Write result.', inputs: [], outputs: [], dependencies: ['ACT-102'],
        acceptance: 'Text checked.', risks: [], writer: 'foreground', next_step: 'Wait for ACT-102.',
        domain: 'writing', size: 'small', blockers: []
      }
    }],
    ['experiments/runs/RUN-101.md', { id: 'RUN-101', type: 'run', path: 'experiments/runs/RUN-101.md', attributes: { type: 'run', id: 'RUN-101', status: 'closed' } }],
    ['evidence/claims/CLM-101.md', { id: 'CLM-101', type: 'claim', path: 'evidence/claims/CLM-101.md', attributes: { type: 'claim', id: 'CLM-101', status: 'closed' } }]
  ];
  const replacements = overrides.entries ?? [];
  return new Map([...entries, ...replacements]);
}

export function capacityCalendarFixture(overrides = {}) {
  return {
    asOf: '2026-08-05',
    timezone: 'UTC',
    defaultWeeklyUnits: 5,
    weeks: [{ weekStart: '2026-08-03', availableUnits: 3, reason: 'Travel week.' }],
    ...overrides
  };
}

export function createCoreFixture(overrides = {}) {
  return {
    project: projectConfigAt(),
    contract: validContract(),
    manifest: validManifest(),
    catalog: catalogFixture(),
    mixedWork: mixedWorkCatalog(),
    capacityCalendar: capacityCalendarFixture(),
    ...overrides
  };
}

export function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; }
    },
    output: () => ({ stdout, stderr })
  };
}

export async function acceptActionFixture(root, id) {
  await recordActionCheck(root, id, { check_id: 'acceptance', candidate_version: 'fixture-v1', outcome: 'pass', evidence: 'Fixture Artifact inspected.' });
  return updateRecordStatus(root, id, 'closed', { verifiedAt: new Date().toISOString(), acceptedBy: 'fixture-researcher', reason: 'Fixture accepted.' });
}
