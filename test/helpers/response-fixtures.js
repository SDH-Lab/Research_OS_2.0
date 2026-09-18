const start = Date.parse('2026-08-03T00:00:00.000Z');

export function lifecycle(status = 'in_progress') {
  const route = ['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'closed'];
  const index = route.indexOf(status);
  const history = [];
  for (let step = 0; step < index; step += 1) {
    history.push({ from: route[step], to: route[step + 1], at: new Date(start + ((step + 1) * 1000)).toISOString(), reason: 'fixture transition' });
  }
  return {
    status,
    created: new Date(start).toISOString(),
    updated: new Date(start + (Math.max(index, 0) * 1000)).toISOString(),
    status_history: history,
    ...(status === 'closed' ? { verified_at: new Date(start + (index * 1000)).toISOString() } : {})
  };
}

export function base(type, id, status = 'in_progress', overrides = {}) {
  return { schema_version: 1, type, id, ...lifecycle(status), ...overrides };
}

export function project(overrides = {}) {
  return {
    schema_version: 1, type: 'project', id: 'PRJ-001', status: 'defined',
    created: new Date(start).toISOString(), updated: new Date(start).toISOString(), status_history: [],
    project_id: 'demo', title: 'Demo', stage: 'revision', foreground_objective: 'Close reviewer concerns.',
    active_plan: 'plans/active.md', core_version: '2.0.0', modules: ['reviews', 'evidence', 'writing'], approved_code_roots: [],
    forecast_settings: {
      as_of: '2026-08-03', timezone: 'UTC', integration_buffer: 0.2, default_weekly_capacity: 5, capacity_calendar: []
    },
    resources: {
      review: { uri: '/vault/review', role: 'decision-letter', access: 'read-only', identity: 'review-v1' },
      writing: { uri: '/vault/writing', role: 'canonical-writing', access: 'read-write', identity: 'writing-v1' },
      results: { uri: '/vault/results', role: 'accepted-results', access: 'read-only', identity: 'results-v1' },
      artifacts: { uri: '/vault/artifacts', role: 'rendered-delivery', access: 'read-only', identity: 'artifacts-v1' }
    },
    canonical_writing_sources: {
      response: { resource_ref: 'writing:response.tex', source_identity: 'response-src-v1', content_identity: 'response-content-v1' },
      manuscript_clean: { resource_ref: 'writing:manuscript-clean.tex', source_identity: 'clean-src-v1', content_identity: 'manuscript-content-v1' },
      manuscript_marked: { resource_ref: 'writing:manuscript-marked.tex', source_identity: 'marked-src-v1', content_identity: 'manuscript-content-v1' }
    },
    ...overrides
  };
}

export function concern(overrides = {}) {
  return base('driver', 'CON-001', 'closed', {
    driver_kind: 'concern', source: 'Reviewer 1, comment 1', source_comment_id: 'R1-C1', source_ref: 'review:decision-letter.txt',
    question: 'Does the method improve the registered endpoint?', importance: 'Required by Reviewer 1.', scope: 'Registered endpoint only.', priority: 'high',
    closure_conditions: ['Both actions and the response are verified.'], actions: ['ACT-001', 'ACT-002'], ...overrides
  });
}

export function researchQuestion(overrides = {}) {
  return base('driver', 'RQ-099', 'closed', {
    driver_kind: 'research_question', source: 'Registered research brief',
    question: 'Does the intervention improve the endpoint?', importance: 'It determines the next study.',
    scope: 'Registered cohort only.', priority: 'high', closure_conditions: ['Evidence reviewed.'], actions: [],
    ...overrides
  });
}

export function action(id, overrides = {}) {
  return base('action', id, 'closed', {
    driver: 'CON-001', purpose: `Close ${id}.`, inputs: [], outputs: ['EVD-001'], dependencies: [],
    acceptance: 'Output checked.', risks: [], writer: 'foreground-session', next_step: 'none',
    domain: 'analysis', size: 'small', blockers: [], ...overrides
  });
}

export function evidence(overrides = {}) {
  return base('evidence', 'EVD-001', 'closed', {
    sources: ['CON-001', 'results:metrics.json'], figures_and_numbers: ['91.2%'], interpretation: 'The registered endpoint improved.',
    counterevidence: [], limitations: ['One cohort.'], supported_claims: ['CLM-001'], unsupported_claims: [], writing_destinations: ['WRT-001'], ...overrides
  });
}

export function claim(overrides = {}) {
  return base('claim', 'CLM-001', 'closed', {
    statement: 'Performance was 91.2% on the registered endpoint.', evidence: ['EVD-001'], conditions: ['Registered cohort.'],
    prohibited_expansion: ['No external-cohort claim.'], confidence_and_limitations: 'One accepted run.', use_locations: ['WRT-001'],
    approval_status: 'approved', reopen_conditions: ['Source correction.'], ...overrides
  });
}

export function experiment(overrides = {}) {
  return base('experiment', 'EXP-001', 'closed', {
    scientific_question: 'Does the registered endpoint improve?', variables: ['method'], fixed_conditions: ['split'],
    data_model_boundary: 'Registered cohort.', priors_and_bias: [], forbidden_shortcuts: [],
    outcome_definitions: { endpoint: 'registered metric' }, stopping_conditions: ['complete'], acceptance: 'Protocol passed.',
    ...overrides
  });
}

export function manifest(overrides = {}) {
  const closed = lifecycle('closed');
  return {
    schema_version: 1, type: 'manifest', id: 'MAN-001', ...closed,
    status_history: closed.status_history.slice(1),
    code_root: 'code', resolved_code_root: { resource: 'code', uri: '/code' }, entrypoint: 'train.py', commit: 'abcdef1',
    resolved_config: { seed: 1 }, resolved_config_hash: 'a'.repeat(64),
    data_and_split: { dataset_root: 'results:data', manifest: 'results:split.json', split_function: 'fixed', seed: 1, class_or_domain_order: ['a'] },
    model_and_checkpoint: { model_class: 'Model', checkpoint: 'results:checkpoint.pt' },
    training_boundary: { trainable_parameters: ['head'], loss: 'ce', sampler: 'fixed', gradient_accumulation: 1 },
    optimizer_scheduler: { optimizer: { name: 'sgd', parameters: {} }, scheduler: { name: 'none', parameters: {} }, checkpoint_selection: 'last', early_stopping: { mode: 'disabled', monitor: null, patience: null } },
    evaluator: { implementation: 'eval.py', metrics: ['accuracy'], aggregation: 'mean', state: 'frozen' },
    command: 'python train.py', environment: { runtime: 'python', packages: [], hardware: 'cpu' },
    output_location: 'results:runs/001', expected_artifacts: ['results:runs/001/metrics.json'],
    normalized_hash: 'b'.repeat(64), resolved_at: '2026-08-03T00:00:01.000Z', project_authority: {}, project_authority_hash: 'c'.repeat(64),
    resolved_outputs: {}, manifest_complete: true, ...overrides
  };
}

export function run(overrides = {}) {
  return base('run', 'RUN-001', 'closed', {
    experiment: 'EXP-001', manifest: 'MAN-001', started_at: '2026-08-03T00:00:01.000Z', ended_at: '2026-08-03T00:00:02.000Z',
    run_status: 'completed', logs: [], artifacts: ['results:metrics.json'], failure_details: '', official: true, ...overrides
  });
}

export function result(overrides = {}) {
  return base('result', 'RES-001', 'closed', {
    run: 'RUN-001', protocol_checks: ['passed'], numeric_checks: ['passed'], classification: 'adopted',
    adoption_reason: 'Protocol and endpoint passed.', limitations: [], follow_up: [], ...overrides
  });
}

export function decision(overrides = {}) {
  return base('decision', 'DEC-001', 'closed', {
    question: 'How should the reviewer concern be resolved?', options: ['Add analysis', 'Explain only'],
    selected_option: 'Add analysis', rationale: 'The accepted evidence directly answers the concern.',
    impact: ['WRT-001'], approver: 'PI', decision_date: '2026-08-03T00:00:06.000Z', reopen_conditions: ['Evidence changes.'],
    ...overrides
  });
}

export function provenanceCatalog(overrides = {}) {
  return responseCatalog({
    'evidence/packets/EVD-001.md': evidence({ sources: ['CON-001', 'RES-001', 'results:metrics.json'] }),
    'experiments/results/RES-001.md': result(),
    'experiments/runs/RUN-001.md': run(),
    'experiments/experiments/EXP-001.md': experiment(),
    'experiments/manifests/MAN-001.md': manifest(),
    ...overrides
  });
}

export function change(overrides = {}) {
  return base('writing', 'WRT-002', 'closed', {
    writing_kind: 'manuscript_change', purpose: 'Synchronize the result in both manuscript variants.', claims: ['CLM-001'],
    target_location: 'Section 4.2', draft: 'Performance was 91.2% on the registered endpoint.', synchronization_status: 'synchronized', verification_result: 'passed',
    target_source_keys: ['manuscript_clean', 'manuscript_marked'], source_identities: { manuscript_clean: 'clean-src-v1', manuscript_marked: 'marked-src-v1' },
    location_anchor: 'sec:results', change_summary: 'Added the accepted endpoint result.', response_blocks: ['WRT-001'],
    numeric_sources: [{ literal: '91.2%', evidence: 'EVD-001', locator: 'results:metrics.json' }], ...overrides
  });
}

export function response(overrides = {}) {
  return base('writing', 'WRT-001', 'closed', {
    writing_kind: 'response_block', purpose: 'Answer Reviewer 1 comment 1.', claims: ['CLM-001'], target_location: 'response:R1-C1',
    draft: 'We agree. Performance was 91.2% on the registered endpoint.', synchronization_status: 'synchronized', verification_result: 'passed', concern: 'CON-001',
    direct_answer: 'Yes. Performance was 91.2% on the registered endpoint.', evidence_or_reason: ['EVD-001'], limitations: 'The evidence is limited to one registered cohort.',
    manuscript_changes: ['WRT-002'], covered_actions: ['ACT-001', 'ACT-002'],
    numeric_sources: [{ literal: '91.2%', evidence: 'EVD-001', locator: 'results:metrics.json' }], ...overrides
  });
}

export function ref(path, attributes) {
  return Object.freeze({ id: attributes.id, type: attributes.type, path, attributes: Object.freeze(attributes) });
}

export function responseCatalog(overrides = {}) {
  const items = {
    'PROJECT.md': project(), 'reviews/concerns/CON-001.md': concern(),
    'plans/actions/ACT-001.md': action('ACT-001'), 'plans/actions/ACT-002.md': action('ACT-002', { inputs: ['EVD-001'], outputs: ['WRT-002'] }),
    'evidence/packets/EVD-001.md': evidence(), 'evidence/claims/CLM-001.md': claim(),
    'writing/response/WRT-001.md': response(), 'writing/changes/WRT-002.md': change(), ...overrides
  };
  return new Map(Object.entries(items).filter(([, attributes]) => attributes !== null).map(([path, attributes]) => [path, ref(path, attributes)]));
}
