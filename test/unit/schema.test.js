import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { ResearchOSError } from '../../src/lib/errors.js';
import { loadCore } from '../../src/core/catalog.js';
import { renderTemplate } from '../../src/core/render.js';
import { validateRecord } from '../../src/validation/validator.js';

const coreRoot = join(process.cwd(), 'core');
const validBase = {
  schema_version: 1,
  type: 'action',
  id: 'ACT-001',
  status: 'defined',
  created: '2026-08-03T00:00:00Z',
  updated: '2026-08-03T00:00:00Z',
  status_history: []
};
const validAction = {
  ...validBase,
  purpose: 'Verify the baseline.',
  inputs: ['RES-001'],
  outputs: ['EVD-001'],
  dependencies: [],
  risks: [],
  writer: 'foreground-session',
  next_step: 'Review the evidence note.',
  domain: 'analysis',
  size: 'small',
  blockers: []
};

test('action schema requires driver and acceptance criteria', () => {
  const issues = validateRecord('action', validAction);
  assert.deepEqual(issues.map(x => x.path).sort(), ['/acceptance', '/driver']);
});

test('Action dependencies are a unique ID set', () => {
  const issues = validateRecord('action', {
    ...validAction, driver: 'RQ-001', acceptance: 'Artifact reviewed.', dependencies: ['RES-001', 'RES-001']
  });
  assert.equal(issues.some(issue => issue.path === '/dependencies' && issue.code === 'uniqueItems'), true);
});

test('record validation rejects an invalid date-time and unknown schema names', () => {
  const issues = validateRecord('action', { ...validAction, created: '2026-08-03', driver: 'RQ-001', acceptance: 'Artifact reviewed.' });
  assert.equal(issues.some(issue => issue.path === '/created' && issue.code === 'format'), true);
  assert.throws(() => validateRecord('not-a-record', validBase), error => error instanceof ResearchOSError && error.code === 'CORE_SCHEMA_NOT_FOUND');
});

test('record validation rejects an impossible calendar date-time', () => {
  const issues = validateRecord('action', { ...validAction, created: '2026-02-31T00:00:00Z', driver: 'RQ-001', acceptance: 'Artifact reviewed.' });
  assert.equal(issues.some(issue => issue.path === '/created' && issue.code === 'format'), true);
});

test('Core schemas reject malformed fixed provenance fields while Evidence sources retain ID and resource-ref strings', () => {
  const cases = [
    ['claim', { type: 'claim', id: 'CLM-901', evidence: ['plain.pdf'] }, ['/evidence/0']],
    ['evidence', { type: 'evidence', id: 'EVD-901', counterevidence: [['EVD-902']], supported_claims: [42], writing_destinations: [{}] }, ['/counterevidence/0', '/supported_claims/0', '/writing_destinations/0']],
    ['result', { type: 'result', id: 'RES-901', run: ['RUN-901'], follow_up: [['ACT-901']] }, ['/run', '/follow_up/0']],
    ['run', { type: 'run', id: 'RUN-901', experiment: {}, manifest: [] }, ['/experiment', '/manifest']],
    ['driver', { type: 'driver', id: 'RQ-901', actions: ['plain.pdf'] }, ['/actions/0']],
    ['action', { type: 'action', id: 'ACT-901', driver: 42, inputs: [['RES-901']], outputs: ['plain.pdf'], dependencies: [{}] }, ['/driver', '/inputs/0', '/outputs/0', '/dependencies/0']],
    ['writing', { type: 'writing', id: 'WRT-901', claims: [false] }, ['/claims/0']],
    ['decision', { type: 'decision', id: 'DEC-901', impact: [['CLM-901']] }, ['/impact/0']],
    ['incident', { type: 'incident', id: 'INC-901', evidence: ['plain.pdf'] }, ['/evidence/0']]
  ];
  for (const [schema, overrides, expectedPaths] of cases) {
    const issues = validateRecord(schema, { ...validBase, ...overrides });
    for (const path of expectedPaths) {
      assert.equal(issues.some(issue => issue.path === path), true, `${schema} must reject malformed ${path}`);
    }
  }

  const evidenceIssues = validateRecord('evidence', {
    ...validBase,
    type: 'evidence',
    id: 'EVD-999',
    sources: ['RQ-001', 'papers:article.pdf']
  });
  assert.equal(evidenceIssues.some(issue => issue.path.startsWith('/sources')), false);
});

test('core catalog loads the fixed version, schemas, templates, and transitions', async () => {
  const core = await loadCore(coreRoot);
  assert.equal(core.version, '2.0.0');
  assert.equal(typeof core.schemas.action, 'object');
  assert.match(core.templates.records.action, /{{ID}}/);
  assert.deepEqual(core.transitions.transitions.closed, ['reopened']);
});

test('all Core schemas extend the base contract and require their minimum fields', async () => {
  const core = await loadCore(coreRoot);
  const expected = {
    project: ['project_id', 'title', 'stage', 'foreground_objective', 'active_plan', 'core_version', 'modules', 'resources', 'approved_code_roots', 'canonical_writing_sources', 'forecast_settings'],
    'exec-plan': [
      'completion_conditions', 'scope', 'out_of_scope', 'risks', 'blockers', 'dependencies', 'background_register',
      'writable_paths', 'resume_point', 'disruption_mode', 'latest_checkpoint'
    ],
    driver: ['driver_kind', 'source', 'question', 'importance', 'scope', 'priority', 'closure_conditions', 'actions'],
    action: ['driver', 'purpose', 'inputs', 'outputs', 'dependencies', 'acceptance', 'risks', 'writer', 'next_step', 'domain', 'size', 'blockers'],
    experiment: ['scientific_question', 'variables', 'fixed_conditions', 'data_model_boundary', 'priors_and_bias', 'forbidden_shortcuts', 'outcome_definitions', 'stopping_conditions', 'acceptance'],
    manifest: ['code_root', 'resolved_code_root', 'entrypoint', 'commit', 'resolved_config', 'resolved_config_hash', 'data_and_split', 'model_and_checkpoint', 'training_boundary', 'optimizer_scheduler', 'evaluator', 'command', 'environment', 'output_location', 'expected_artifacts', 'normalized_hash', 'resolved_at', 'project_authority', 'project_authority_hash', 'resolved_outputs', 'manifest_complete'],
    run: ['experiment', 'manifest', 'started_at', 'ended_at', 'run_status', 'logs', 'artifacts', 'failure_details', 'official'],
    result: ['run', 'protocol_checks', 'numeric_checks', 'classification', 'adoption_reason', 'limitations', 'follow_up'],
    evidence: ['sources', 'figures_and_numbers', 'interpretation', 'counterevidence', 'limitations', 'supported_claims', 'unsupported_claims', 'writing_destinations'],
    claim: ['statement', 'evidence', 'conditions', 'prohibited_expansion', 'confidence_and_limitations', 'use_locations', 'approval_status', 'reopen_conditions'],
    writing: ['writing_kind', 'purpose', 'claims', 'target_location', 'draft', 'synchronization_status', 'verification_result'],
    decision: ['question', 'options', 'selected_option', 'rationale', 'impact', 'approver', 'decision_date', 'reopen_conditions'],
    incident: ['kind', 'fact_or_risk', 'evidence', 'impact_scope', 'root_cause_status', 'remediation', 'reverification', 'guardrail_candidate']
  };
  for (const [name, required] of Object.entries(expected)) {
    const schema = core.schemas[name];
    assert.equal(schema.allOf[0].$ref, 'record-base', `${name} must extend record-base`);
    for (const field of required) assert.equal(schema.allOf[1].required.includes(field), true, `${name} must require ${field}`);
  }
  assert.equal(core.schemas.project.allOf[1].properties.type.const, 'project');
  assert.equal(core.schemas['exec-plan'].allOf[1].properties.type.const, 'exec_plan');
  assert.deepEqual(core.schemas.incident.allOf[1].properties.type.enum, ['incident', 'risk']);
});

test('Run and Incident schemas report lifecycle placeholders as required', () => {
  const runIssues = validateRecord('run', { ...validBase, type: 'run', id: 'RUN-001' });
  const incidentIssues = validateRecord('incident', { ...validBase, type: 'incident', id: 'INC-001' });
  assert.equal(runIssues.some(issue => issue.path === '/ended_at'), true);
  assert.equal(runIssues.some(issue => issue.path === '/failure_details'), true);
  assert.equal(incidentIssues.some(issue => issue.path === '/fact_or_risk'), true);
});

test('project and Active ExecPlan templates render the full base record fields', async () => {
  const core = await loadCore(coreRoot);
  const values = {
    PROJECT_RECORD_ID: 'PRJ-001', PROJECT_ID: 'demo', TITLE: 'Demo', STAGE: 'research', PROJECT_YAML_ID: '"demo"', TITLE_YAML: '"Demo"', STAGE_YAML: '"research"', FOREGROUND_OBJECTIVE: 'Verify', ACTIVE_PLAN: 'plans/active.md',
    CORE_VERSION: '2.0.0', RESOURCES: '{}', FORECAST_SETTINGS: '{"as_of":"2026-08-03","timezone":"UTC","integration_buffer":0.2,"default_weekly_capacity":5,"capacity_calendar":[]}', NEXT_DECISION: 'Approve', ACTIVE_PLAN_ID: 'PLAN-001', DATE: '2026-08-03T00:00:00Z',
    RESUME_POINT: '{"last_verified_point":"Initialized","next_action":"Read results","next_command_or_edit":null,"required_files":[],"risks":[],"reforecast_trigger":null}'
  };
  for (const template of [core.templates.project.PROJECT, core.templates.project['active-plan']]) {
    const rendered = renderTemplate(template, values);
    for (const field of ['schema_version', 'type', 'id', 'status', 'created', 'updated', 'status_history']) {
      assert.match(rendered, new RegExp(`^${field}:`, 'm'));
    }
  }
});

test('conditional in-progress closure is an allowed edge requiring verification', async () => {
  const core = await loadCore(coreRoot);
  assert.equal(core.transitions.transitions.in_progress.includes('closed'), true);
  assert.deepEqual(core.transitions.conditions['in_progress->closed'], { requires: ['verified_at'] });
  assert.equal(core.transitions.transitions.verified.includes('closed'), true);
  assert.deepEqual(core.transitions.conditions['verified->closed'], { requires: ['verified_at'] });
});

test('template rendering substitutes known values and rejects unresolved tokens', () => {
  assert.equal(renderTemplate('Project {{PROJECT_ID}}: {{TITLE}}', { PROJECT_ID: 'demo', TITLE: 'Demo' }), 'Project demo: Demo');
  assert.throws(() => renderTemplate('Project {{PROJECT_ID}}: {{TITLE}}', { PROJECT_ID: 'demo' }), error => error instanceof ResearchOSError && error.code === 'CORE_TEMPLATE_TOKEN');
});
