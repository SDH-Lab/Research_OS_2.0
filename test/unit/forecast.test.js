import assert from 'node:assert/strict';
import test from 'node:test';
import { mixedWorkCatalog, capacityCalendarFixture } from '../helpers/fixtures.js';
import { ResearchOSError } from '../../src/lib/errors.js';
import { validateRecord } from '../../src/validation/validator.js';
import { forecastCompletion, summarizeActions } from '../../src/views/forecast.js';

const baseTime = '2026-07-06T00:00:00Z';

function history(status, transitions) {
  return {
    status,
    created: baseTime,
    updated: transitions.at(-1)?.at ?? baseTime,
    status_history: transitions,
    ...(status === 'closed' ? { verified_at: transitions.at(-1)?.at ?? baseTime } : {})
  };
}

function action(id, overrides = {}) {
  const created = overrides.created ?? baseTime;
  const transitionAt = seconds => new Date(Date.parse(created) + seconds * 1000).toISOString();
  const attributes = {
    schema_version: 1, type: 'action', id,
    ...history('ready', [
      { from: 'inbox', to: 'defined', at: transitionAt(1), reason: 'defined' },
      { from: 'defined', to: 'ready', at: transitionAt(2), reason: 'ready' }
    ]),
    driver: 'RQ-001', purpose: id, inputs: [], outputs: [], dependencies: [], acceptance: 'checked', risks: [],
    writer: 'foreground', next_step: 'continue', domain: 'analysis', size: 'small', blockers: [], ...overrides
  };
  const path = `plans/actions/${id}.md`;
  return [path, { id, type: 'action', path, attributes }];
}

function record(path, attributes) {
  return [path, { id: attributes.id, type: attributes.type, path, attributes }];
}

function resultAttributes(id, lifecycle, overrides = {}) {
  return {
    schema_version: 1, type: 'result', id, ...lifecycle,
    run: 'RUN-001', protocol_checks: [], numeric_checks: [], classification: 'adopted',
    adoption_reason: 'Accepted.', limitations: [], follow_up: [], ...overrides
  };
}

function evidenceAttributes(id, lifecycle, sources, overrides = {}) {
  return {
    schema_version: 1, type: 'evidence', id, ...lifecycle, sources,
    figures_and_numbers: [], interpretation: 'Packet interpretation.', counterevidence: [],
    limitations: [], supported_claims: [], unsupported_claims: [], writing_destinations: [], ...overrides
  };
}

function calendar(overrides = {}) {
  return capacityCalendarFixture({
    asOf: '2026-08-05', timezone: 'UTC', defaultWeeklyUnits: 5,
    weeks: [
      { weekStart: '2026-08-03', availableUnits: 3, reason: 'Travel.' },
      { weekStart: '2026-08-10', availableUnits: 5, reason: 'Normal.' },
      { weekStart: '2026-08-17', availableUnits: 5, reason: 'Normal.' }
    ],
    ...overrides
  });
}

function rangeEnd(range) {
  return range?.latest ?? '9999-12-31';
}

test('work summary counts only Actions and groups remaining work by domain and size', () => {
  const summary = summarizeActions(mixedWorkCatalog(), calendar());
  assert.equal(summary.total, 3);
  assert.equal(summary.remaining, 3);
  assert.deepEqual(summary.byDomain, { analysis: 1, experiment: 1, writing: 1 });
  assert.deepEqual(summary.bySize, { large: 1, medium: 1, small: 1 });
  assert.equal(summary.inProgress, 1);
  assert.equal(summary.futureCapacity[0].availableUnits, 3);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.byDomain), true);
});

test('summary preserves blocker history, ages active blockers from asOf, and exposes unknown sentinels', () => {
  const catalog = new Map([
    action('ACT-201', {
      domain: 'unclassified', size: 'unestimated',
      ...history('in_progress', [
        { from: 'inbox', to: 'defined', at: '2026-07-06T00:00:01Z', reason: 'defined' },
        { from: 'defined', to: 'ready', at: '2026-07-06T00:00:02Z', reason: 'ready' },
        { from: 'ready', to: 'in_progress', at: '2026-07-06T00:00:03Z', reason: 'started' }
      ]), updated: '2026-08-04T00:00:00Z',
      blockers: [
        {
          id: 'BLK-1', category: 'dependency', critical_path: true, root_cause: 'Source unavailable.', resolution: null,
          description: 'Await source.', owner: 'Researcher', since: '2026-07-30T12:00:00Z',
          next_unblock_action: 'Ask for source.', review_at: '2026-08-06T00:00:00Z', status: 'active', resolved_at: null
        },
        {
          id: 'BLK-2', category: 'other', critical_path: false, root_cause: 'Unknown.', resolution: 'Resolved.',
          description: 'Old blocker.', owner: 'Researcher', since: '2026-07-20T00:00:00Z',
          next_unblock_action: 'Recheck.', review_at: '2026-07-22T00:00:00Z', status: 'resolved', resolved_at: '2026-07-21T00:00:00Z'
        }
      ]
    })
  ]);
  const summary = summarizeActions(catalog, calendar());
  assert.deepEqual(summary.blockers.map(item => ({ id: item.actionId, ageDays: item.ageDays })), [{ id: 'ACT-201', ageDays: 6 }]);
  assert.equal(summary.issues.some(item => item.code === 'ACTION_DOMAIN_UNCLASSIFIED'), true);
  assert.equal(summary.issues.some(item => item.code === 'ACTION_SIZE_UNESTIMATED'), true);
});

test('summary counts valid current closures once, includes zero-close complete weeks, and derives reopen transitions', () => {
  const closedTransitions = [
    { from: 'inbox', to: 'defined', at: '2026-07-06T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-06T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-07T00:00:00Z', reason: 'started' },
    { from: 'in_progress', to: 'closed', at: '2026-07-10T00:00:00Z', reason: 'closed' },
    { from: 'closed', to: 'reopened', at: '2026-07-14T00:00:00Z', reason: 'new evidence' },
    { from: 'reopened', to: 'defined', at: '2026-07-15T00:00:00Z', reason: 'repair' },
    { from: 'defined', to: 'ready', at: '2026-07-16T00:00:00Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-17T00:00:00Z', reason: 'restart' },
    { from: 'in_progress', to: 'closed', at: '2026-07-27T00:00:00Z', reason: 'reclosed' }
  ];
  const reopenedOpen = [
    ...closedTransitions.slice(0, 4),
    { from: 'closed', to: 'reopened', at: '2026-07-28T00:00:00Z', reason: 'scope changed' }
  ];
  const catalog = new Map([
    action('ACT-301', { ...history('closed', closedTransitions), domain: 'experiment', size: 'medium', affected_ids: ['ACT-301'] }),
    action('ACT-302', { ...history('reopened', reopenedOpen), domain: 'writing', size: 'small', verified_at: '2026-07-10T00:00:00Z', affected_ids: ['ACT-302'] })
  ]);
  const summary = summarizeActions(catalog, calendar());
  assert.equal(summary.reopened.transitions, 2);
  assert.equal(summary.reopened.current, 1);
  assert.equal(summary.reopened.rate, 1);
  assert.deepEqual(summary.throughputHistory.weeks.map(item => item.closed), [0, 0, 1]);
  assert.equal(summary.throughputHistory.weeks[0].weekStart, '2026-07-13');
  assert.equal(summary.throughputHistory.weeks.at(-1).weekStart, '2026-07-27');
});

test('summary excludes the Action creation week in UTC and the declared timezone', () => {
  const sunday = action('ACT-310', { created: '2026-07-19T12:00:00Z', updated: '2026-07-19T12:00:02Z' });
  const monday = action('ACT-311', { created: '2026-07-13T00:00:00Z', updated: '2026-07-13T00:00:02Z' });
  for (const candidate of [sunday, monday]) {
    assert.deepEqual(
      summarizeActions(new Map([candidate]), calendar()).throughputHistory.weeks.map(item => item.weekStart),
      ['2026-07-20', '2026-07-27']
    );
  }

  const boundary = action('ACT-312', { created: '2026-08-02T16:30:00Z', updated: '2026-08-02T16:30:02Z' });
  const utcWeeks = summarizeActions(new Map([boundary]), calendar({ asOf: '2026-08-26', timezone: 'UTC', weeks: [] })).throughputHistory.weeks;
  const asiaWeeks = summarizeActions(new Map([boundary]), calendar({ asOf: '2026-08-26', timezone: 'Asia/Shanghai', weeks: [] })).throughputHistory.weeks;
  assert.deepEqual(utcWeeks.map(item => item.weekStart), ['2026-08-03', '2026-08-10', '2026-08-17']);
  assert.deepEqual(asiaWeeks.map(item => item.weekStart), ['2026-08-10', '2026-08-17']);
});

test('summary reports completed and pending Result-to-Evidence handoffs without guessing negative dates', () => {
  const closed = at => ({
    ...history('closed', [
      { from: 'inbox', to: 'defined', at: '2026-07-01T00:00:01Z', reason: 'defined' },
      { from: 'defined', to: 'ready', at: '2026-07-01T00:00:02Z', reason: 'ready' },
      { from: 'ready', to: 'in_progress', at: '2026-07-01T00:00:03Z', reason: 'started' },
      { from: 'in_progress', to: 'closed', at, reason: 'accepted' }
    ]),
    created: '2026-07-01T00:00:00Z'
  });
  const catalog = new Map([
    record('experiments/results/RES-201.md', resultAttributes('RES-201', closed('2026-07-20T00:00:00Z'))),
    record('experiments/results/RES-202.md', resultAttributes('RES-202', closed('2026-07-21T00:00:00Z'), { classification: 'credible_negative' })),
    record('experiments/results/RES-203.md', resultAttributes('RES-203', closed('2026-07-25T00:00:00Z'), { classification: 'excluded' })),
    record('experiments/results/RES-999.md', resultAttributes('RES-999', closed('2026-07-20T00:00:00Z'), { classification: 'invalid' })),
    record('evidence/packets/EVD-201.md', evidenceAttributes('EVD-201', closed('2026-07-23T00:00:00Z'), ['RES-201'])),
    record('evidence/packets/EVD-202.md', evidenceAttributes('EVD-202', {
      ...history('review', [
        { from: 'inbox', to: 'defined', at: '2026-07-21T00:00:01Z', reason: 'defined' },
        { from: 'defined', to: 'ready', at: '2026-07-21T00:00:02Z', reason: 'ready' },
        { from: 'ready', to: 'in_progress', at: '2026-07-21T00:00:03Z', reason: 'started' },
        { from: 'in_progress', to: 'review', at: '2026-07-22T00:00:00Z', reason: 'review' }
      ]), created: '2026-07-21T00:00:00Z'
    }, ['RES-202'])),
    record('evidence/packets/EVD-203.md', evidenceAttributes('EVD-203', closed('2026-07-24T00:00:00Z'), ['RES-203']))
  ]);
  const summary = summarizeActions(catalog, calendar());
  assert.equal(summary.handoff.completed.length, 1);
  assert.equal(summary.handoff.completed.find(item => item.resultId === 'RES-201').delayDays, 3);
  assert.equal(summary.handoff.pending.find(item => item.resultId === 'RES-202').reason, 'evidence_not_closed');
  assert.equal(summary.handoff.pending.find(item => item.resultId === 'RES-203').reason, 'negative_chronology');
  assert.equal(summary.issues.some(item => item.code === 'HANDOFF_NEGATIVE_DELAY'), true);
  assert.equal(summary.handoff.completed.some(item => item.resultId === 'RES-999'), false);
});

test('early forecast returns three ordered ranges with scenario assumptions and capacity disruption', () => {
  const input = {
    actions: new Map([
      action('ACT-401', { domain: 'experiment', size: 'large' }),
      action('ACT-402', { domain: 'writing', size: 'medium', dependencies: ['ACT-401'], risks: ['May need rerun.'] })
    ]),
    throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar(), integrationBuffer: 0.2
  };
  const result = forecastCompletion(input);
  assert.equal(result.method, 'scenario');
  for (const key of ['optimistic', 'median', 'conservative']) {
    assert.deepEqual(Object.keys(result[key]), ['earliest', 'latest']);
    assert.match(result[key].earliest, /^2026-\d{2}-\d{2}$/);
    assert.match(result[key].latest, /^2026-\d{2}-\d{2}$/);
  }
  assert.equal(rangeEnd(result.optimistic) <= rangeEnd(result.median), true);
  assert.equal(rangeEnd(result.median) <= rangeEnd(result.conservative), true);
  assert.equal(result.assumptions.some(item => item.includes('scenario')), true);
  assert.equal(result.changeReasons.includes('No canonical previous forecast baseline; this is the initial forecast.'), true);
  assert.deepEqual(result.criticalDependencies.find(item => item.type === 'chain').actions, ['ACT-401', 'ACT-402']);
});

test('forecast uses observed complete weeks including zero weeks and visibly falls back for unobserved groups', () => {
  const result = forecastCompletion({
    actions: new Map([
      action('ACT-501', { domain: 'experiment', size: 'medium' }),
      action('ACT-502', { domain: 'writing', size: 'small' })
    ]),
    throughputHistory: {
      completeWeeks: 3,
      weeks: [
        { weekStart: '2026-07-13', closed: 1, closedByDomain: { experiment: 1 }, closedBySize: { medium: 1 }, closedUnitsByDomain: { experiment: 2 } },
        { weekStart: '2026-07-20', closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} },
        { weekStart: '2026-07-27', closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} }
      ]
    },
    capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(result.method, 'observed');
  assert.equal(result.assumptions.some(item => item.includes('zero-closure weeks')), true);
  assert.equal(result.assumptions.some(item => item.includes('writing') && item.includes('scenario fallback')), true);
  assert.notEqual(result.confidence, 'high');
});

test('forecast change reasons derive scope additions and reopen history from canonical Actions', () => {
  const transitions = [
    { from: 'inbox', to: 'defined', at: '2026-08-03T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-08-03T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-08-03T00:00:03Z', reason: 'started' },
    { from: 'in_progress', to: 'closed', at: '2026-08-03T01:00:00Z', reason: 'closed' },
    { from: 'closed', to: 'reopened', at: '2026-08-04T00:00:00Z', reason: 'new scope' }
  ];
  const result = forecastCompletion({
    actions: new Map([action('ACT-551', {
      ...history('reopened', transitions), created: '2026-08-03T00:00:00Z', verified_at: '2026-08-03T01:00:00Z', affected_ids: ['ACT-551']
    })]),
    throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(result.changeReasons.some(item => item.includes('current-week scope')), true);
  assert.equal(result.changeReasons.some(item => item.includes('reopen transition')), true);
});

test('forecast withholds dates for missing or cyclic dependencies instead of fabricating completion', () => {
  for (const actions of [
    new Map([action('ACT-601', { dependencies: ['ACT-999'] })]),
    new Map([action('ACT-602', { dependencies: ['ACT-603'] }), action('ACT-603', { dependencies: ['ACT-602'] })])
  ]) {
    const result = forecastCompletion({ actions, throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2 });
    assert.deepEqual(result.optimistic, { earliest: null, latest: null });
    assert.equal(result.criticalDependencies.length > 0, true);
    assert.equal(result.issues.some(item => ['DEPENDENCY_MISSING', 'DEPENDENCY_CYCLE'].includes(item.code)), true);
  }
});

test('forecast returns zero-width asOf ranges when no Action remains', () => {
  const transitions = [
    { from: 'inbox', to: 'defined', at: '2026-07-01T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-01T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-01T00:00:03Z', reason: 'started' },
    { from: 'in_progress', to: 'closed', at: '2026-07-02T00:00:00Z', reason: 'closed' }
  ];
  const result = forecastCompletion({
    actions: new Map([action('ACT-701', { ...history('closed', transitions), created: '2026-07-01T00:00:00Z' })]),
    throughputHistory: {
      completeWeeks: 4,
      weeks: ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'].map(weekStart => ({ weekStart, closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} }))
    },
    capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.deepEqual(result.optimistic, { earliest: '2026-08-05', latest: '2026-08-05' });
  assert.deepEqual(result.median, result.optimistic);
  assert.deepEqual(result.conservative, result.optimistic);
  assert.equal(result.assumptions.includes('No scheduled Actions remain at the canonical asOf date; deferred and retired work is excluded.'), true);
});

test('Action blocker and Project forecast settings receive schema and semantic validation', () => {
  const base = {
    schema_version: 1, type: 'action', id: 'ACT-801', status: 'inbox', created: '2026-08-03T00:00:00Z', updated: '2026-08-03T00:00:00Z', status_history: [],
    driver: 'RQ-001', purpose: 'x', inputs: [], outputs: [], dependencies: [], acceptance: 'x', risks: [], writer: 'x', next_step: 'x',
    domain: 'experiment', size: 'small', blockers: []
  };
  assert.deepEqual(validateRecord('action', base), []);
  const activeWithResolution = validateRecord('action', {
    ...base, blockers: [{ description: 'x', owner: 'x', since: '2026-08-03T00:00:00Z', next_unblock_action: 'x', review_at: '2026-08-04T00:00:00Z', status: 'active', resolved_at: '2026-08-05T00:00:00Z' }]
  });
  assert.equal(activeWithResolution.some(item => item.path.endsWith('/resolved_at')), true);
  const resolvedBeforeSince = validateRecord('action', {
    ...base, blockers: [{ description: 'x', owner: 'x', since: '2026-08-03T00:00:00Z', next_unblock_action: 'x', review_at: '2026-08-04T00:00:00Z', status: 'resolved', resolved_at: '2026-08-02T00:00:00Z' }]
  });
  assert.equal(resolvedBeforeSince.some(item => item.code === 'semantic'), true);
  const blankHumanFields = validateRecord('action', {
    ...base, blockers: [{ description: ' ', owner: '\t', since: '2026-08-03T00:00:00Z', next_unblock_action: '\n', review_at: '2026-08-04T00:00:00Z', status: 'active', resolved_at: null }]
  });
  assert.equal(blankHumanFields.filter(item => item.code === 'semantic').length, 3);
});

test('Project forecast settings reject non-Monday or duplicate overrides and invalid timezone/numbers', () => {
  const project = {
    schema_version: 1, type: 'project', id: 'PRJ-001', status: 'defined', created: '2026-08-03T00:00:00Z', updated: '2026-08-03T00:00:00Z', status_history: [],
    project_id: 'demo', title: 'Demo', stage: 'research', foreground_objective: null, active_plan: 'plans/active.md', core_version: '1.0.0', modules: [], resources: {}, approved_code_roots: [], canonical_writing_sources: {},
    forecast_settings: {
      as_of: '2026-08-03', timezone: 'Mars/Olympus', integration_buffer: Infinity, default_weekly_capacity: 5,
      capacity_calendar: [
        { week_start: '2026-08-04', available_units: 2, reason: 'Tuesday.' },
        { week_start: '2026-08-04', available_units: 3, reason: 'Duplicate.' }
      ]
    }
  };
  const issues = validateRecord('project', project);
  assert.equal(issues.some(item => item.path === '/forecast_settings/timezone'), true);
  assert.equal(issues.some(item => item.path === '/forecast_settings/integration_buffer'), true);
  assert.equal(issues.some(item => item.path.endsWith('/week_start') && item.message.includes('Monday')), true);
  assert.equal(issues.some(item => item.path.endsWith('/week_start') && item.message.includes('unique')), true);
});

test('public forecast APIs fail with stable ResearchOSError instead of raw getter/proxy crashes', () => {
  const toxic = {};
  Object.defineProperty(toxic, 'type', { get() { throw new Error('boom'); } });
  assert.throws(
    () => summarizeActions(new Map([['plans/actions/ACT-901.md', { path: 'plans/actions/ACT-901.md', attributes: toxic }]]), calendar()),
    error => error instanceof ResearchOSError && error.code === 'VALIDATION'
  );
});

function driver(id, status = 'closed', overrides = {}) {
  const route = [
    { from: 'inbox', to: 'defined', at: '2026-07-01T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-01T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-01T00:00:03Z', reason: 'started' },
    { from: 'in_progress', to: 'closed', at: '2026-07-01T00:00:04Z', reason: 'closed' }
  ];
  const take = status === 'closed' ? 4 : status === 'in_progress' ? 3 : status === 'ready' ? 2 : 1;
  const path = `research/questions/${id}.md`;
  const attributes = {
    schema_version: 1, type: 'driver', id, status, created: '2026-07-01T00:00:00Z', updated: route[take - 1].at,
    status_history: route.slice(0, take), ...(status === 'closed' ? { verified_at: route[3].at } : {}),
    driver_kind: 'research_question', source: 'brief', source_comment_id: null, source_ref: null,
    question: 'Question?', importance: 'Important.', scope: 'Registered.', priority: 'high', closure_conditions: ['done'], actions: [],
    ...overrides
  };
  return record(path, attributes);
}

function currentWeekClosedAction(id, size, closedAt) {
  return action(id, {
    size, status: 'closed', created: '2026-08-03T00:00:00Z', updated: closedAt, verified_at: closedAt,
    status_history: [
      { from: 'inbox', to: 'defined', at: '2026-08-03T00:00:01Z', reason: 'defined' },
      { from: 'defined', to: 'ready', at: '2026-08-03T00:00:02Z', reason: 'ready' },
      { from: 'ready', to: 'in_progress', at: '2026-08-03T00:00:03Z', reason: 'started' },
      { from: 'in_progress', to: 'closed', at: closedAt, reason: 'closed' }
    ]
  });
}

test('closed non-Action dependencies satisfy authority while open and wrong-type targets withhold dates', () => {
  const satisfied = forecastCompletion({
    actions: new Map([action('ACT-910', { driver: 'RQ-910', dependencies: ['RQ-910'] }), driver('RQ-910')]),
    throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(satisfied.issues.some(item => item.code.startsWith('DEPENDENCY_')), false);
  assert.notEqual(satisfied.optimistic.earliest, null);

  const unresolved = forecastCompletion({
    actions: new Map([action('ACT-911', { driver: 'RQ-911', dependencies: ['RQ-911'] }), driver('RQ-911', 'in_progress')]),
    throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(unresolved.issues.some(item => item.code === 'DEPENDENCY_UNRESOLVED' && item.path === 'plans/actions/ACT-911.md'), true);
  assert.equal(unresolved.optimistic.earliest, null);

  const claimPath = 'evidence/claims/CLM-912.md';
  const wrongType = forecastCompletion({
    actions: new Map([
      action('ACT-912', { dependencies: ['CLM-912'] }),
      record(claimPath, { type: 'claim', id: 'CLM-912', status: 'closed' })
    ]),
    throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(wrongType.issues.some(item => item.code === 'DEPENDENCY_WRONG_TYPE' && item.path === 'plans/actions/ACT-912.md'), true);
  assert.equal(wrongType.optimistic.earliest, null);
});

test('current-week capacity subtracts closed units and prorates elapsed calendar days', () => {
  const sunday = calendar({ asOf: '2026-08-09', weeks: [], defaultWeeklyUnits: 5 });
  const catalog = new Map([
    currentWeekClosedAction('ACT-920', 'large', '2026-08-08T00:00:00Z'),
    currentWeekClosedAction('ACT-921', 'small', '2026-08-08T01:00:00Z'),
    action('ACT-922', { created: '2026-08-03T00:00:00Z', updated: '2026-08-03T00:00:02Z', size: 'large' }),
    action('ACT-923', { created: '2026-08-03T00:00:00Z', updated: '2026-08-03T00:00:02Z', size: 'small' })
  ]);
  const result = forecastCompletion({ actions: catalog, throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: sunday, integrationBuffer: 0.2 });
  assert.equal(result.optimistic.latest, '2026-08-16');
  assert.equal(result.assumptions.some(item => item.includes('currentRemaining') && item.includes('elapsed')), true);

  const monday = forecastCompletion({
    actions: new Map([action('ACT-924', { created: '2026-08-03T00:00:00Z', size: 'large' }), action('ACT-925', { created: '2026-08-03T00:00:00Z', size: 'small' })]),
    throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar({ asOf: '2026-08-03', weeks: [], defaultWeeklyUnits: 5 }), integrationBuffer: 0.2
  });
  assert.equal(monday.optimistic.latest, '2026-08-09');

  const zeroCurrent = forecastCompletion({
    actions: new Map([action('ACT-926', { created: '2026-08-03T00:00:00Z', size: 'small' })]),
    throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar({ asOf: '2026-08-03', weeks: [{ weekStart: '2026-08-03', availableUnits: 0, reason: 'No capacity.' }], defaultWeeklyUnits: 5 }), integrationBuffer: 0.2
  });
  assert.ok(zeroCurrent.optimistic.earliest >= '2026-08-10');
});

test('current-week capacity uses declared timezone across UTC boundary and DST', () => {
  const closeAt = '2026-08-02T16:30:00Z';
  const closed = currentWeekClosedAction('ACT-930', 'large', closeAt);
  closed[1].attributes = {
    ...closed[1].attributes,
    created: '2026-08-02T00:00:00Z',
    status_history: [
      { from: 'inbox', to: 'defined', at: '2026-08-02T00:00:01Z', reason: 'defined' },
      { from: 'defined', to: 'ready', at: '2026-08-02T00:00:02Z', reason: 'ready' },
      { from: 'ready', to: 'in_progress', at: '2026-08-02T00:00:03Z', reason: 'started' },
      { from: 'in_progress', to: 'closed', at: closeAt, reason: 'closed' }
    ]
  };
  const remaining = action('ACT-931', { created: '2026-08-02T00:00:00Z', size: 'small' });
  const asia = forecastCompletion({
    actions: new Map([closed, remaining]), throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar({ asOf: '2026-08-03', timezone: 'Asia/Shanghai', weeks: [], defaultWeeklyUnits: 5 }), integrationBuffer: 0.2
  });
  const utc = forecastCompletion({
    actions: new Map([closed, remaining]), throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar({ asOf: '2026-08-03', timezone: 'UTC', weeks: [], defaultWeeklyUnits: 5 }), integrationBuffer: 0.2
  });
  assert.ok(asia.optimistic.latest >= utc.optimistic.latest);
  const dst = forecastCompletion({
    actions: new Map([action('ACT-932', { created: '2026-03-02T00:00:00Z' })]), throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar({ asOf: '2026-03-08', timezone: 'America/New_York', weeks: [], defaultWeeklyUnits: 5 }), integrationBuffer: 0.2
  });
  assert.match(dst.optimistic.latest, /^2026-03-/);
});

test('future lifecycle authority is explicit and withholds pure forecasts', () => {
  const future = action('ACT-940', { created: '2026-08-20T00:00:00Z', updated: '2026-08-20T00:00:02Z' });
  const summary = summarizeActions(new Map([future]), calendar({ asOf: '2026-08-05' }));
  assert.equal(summary.issues.some(item => item.code === 'FORECAST_AS_OF_BEFORE_AUTHORITY' && item.path === 'plans/actions/ACT-940.md'), true);
  const forecast = forecastCompletion({ actions: new Map([future]), throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar({ asOf: '2026-08-05' }), integrationBuffer: 0.2 });
  assert.equal(forecast.issues.some(item => item.code === 'FORECAST_AS_OF_BEFORE_AUTHORITY'), true);
  assert.equal(forecast.optimistic.earliest, null);
});

test('handoff uses latest re-close transition and keeps ambiguous/invalid packets pending', () => {
  const resultTransitions = [
    { from: 'inbox', to: 'defined', at: '2026-07-01T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-01T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-01T00:00:03Z', reason: 'start' },
    { from: 'in_progress', to: 'closed', at: '2026-07-02T00:00:00Z', reason: 'first' },
    { from: 'closed', to: 'reopened', at: '2026-07-03T00:00:00Z', reason: 'new evidence' },
    { from: 'reopened', to: 'defined', at: '2026-07-04T00:00:00Z', reason: 'redo' },
    { from: 'defined', to: 'ready', at: '2026-07-05T00:00:00Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-06T00:00:00Z', reason: 'start' },
    { from: 'in_progress', to: 'closed', at: '2026-07-20T00:00:00Z', reason: 'reclose' }
  ];
  const evidenceTransitions = [
    { from: 'inbox', to: 'defined', at: '2026-07-20T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-20T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-20T00:00:03Z', reason: 'start' },
    { from: 'in_progress', to: 'closed', at: '2026-07-22T00:00:00Z', reason: 'packet' }
  ];
  const resultAttrs = resultAttributes('RES-941', { status: 'closed', verified_at: '2026-07-20T00:00:00Z', created: '2026-07-01T00:00:00Z', updated: '2026-07-20T00:00:00Z', status_history: resultTransitions, affected_ids: ['RES-941'] });
  const packet = id => evidenceAttributes(id, { status: 'closed', verified_at: '2026-07-22T00:00:00Z', created: '2026-07-20T00:00:00Z', updated: '2026-07-22T00:00:00Z', status_history: evidenceTransitions }, ['RES-941']);
  const unique = summarizeActions(new Map([
    record('experiments/results/RES-941.md', resultAttrs), record('evidence/packets/EVD-941.md', packet('EVD-941'))
  ]), calendar());
  assert.equal(unique.handoff.completed[0].delayDays, 2);

  const ambiguous = summarizeActions(new Map([
    record('experiments/results/RES-941.md', resultAttrs),
    record('evidence/packets/EVD-941.md', packet('EVD-941')),
    record('evidence/packets/EVD-942.md', packet('EVD-942'))
  ]), calendar());
  assert.equal(ambiguous.handoff.completed.length, 0);
  assert.equal(ambiguous.handoff.pending[0].reason, 'ambiguous_closed_evidence');
  assert.deepEqual(ambiguous.handoff.pending[0].evidencePaths, ['evidence/packets/EVD-941.md', 'evidence/packets/EVD-942.md']);
  assert.equal(ambiguous.handoff.medianDelayDays, null);
});

test('blocker semantic authority rejects impossible lifecycle and is accessor/cycle safe', () => {
  const base = action('ACT-950')[1].attributes;
  const invalidCases = [
    { ...base, blockers: [{ description: 'x', owner: 'x', since: '2026-07-05T00:00:00Z', next_unblock_action: 'x', review_at: '2026-07-04T00:00:00Z', status: 'active', resolved_at: null }] },
    { ...base, blockers: [{ description: 'x', owner: 'x', since: '2026-06-30T00:00:00Z', next_unblock_action: 'x', review_at: '2026-07-07T00:00:00Z', status: 'active', resolved_at: null }] },
    { ...base, status: 'closed', verified_at: '2026-07-06T00:00:02Z', blockers: [{ description: 'x', owner: 'x', since: '2026-07-06T00:00:01Z', next_unblock_action: 'x', review_at: '2026-07-07T00:00:00Z', status: 'active', resolved_at: null }] }
  ];
  for (const value of invalidCases) assert.equal(validateRecord('action', value).some(item => item.code === 'semantic'), true);
  let hits = 0;
  const toxic = { ...base };
  Object.defineProperty(toxic, 'blockers', { enumerable: true, get() { hits += 1; return []; } });
  assert.equal(validateRecord('action', toxic).some(item => item.code === 'unsafe'), true);
  assert.equal(hits, 0);
  const cyclic = { ...base }; cyclic.blockers = []; cyclic.blockers.push(cyclic);
  assert.equal(validateRecord('action', cyclic).some(item => item.code === 'unsafe'), true);
});

test('forecast reports horizon exhaustion and deterministic confidence actions', () => {
  const horizon = forecastCompletion({
    actions: new Map([action('ACT-960')]), throughputHistory: { completeWeeks: 0, weeks: [] },
    capacityCalendar: calendar({ weeks: [], defaultWeeklyUnits: Number.MIN_VALUE }), integrationBuffer: 0.2
  });
  assert.equal(horizon.issues.some(item => item.code === 'FORECAST_HORIZON_EXCEEDED'), true);
  assert.equal(horizon.confidence, 'low');
  assert.equal(horizon.confidenceActions.some(item => item.includes('capacity')), true);
  assert.equal(Object.isFrozen(horizon.confidenceActions), true);

  const sentinel = forecastCompletion({
    actions: new Map([action('ACT-961', { domain: 'unclassified', size: 'unestimated' })]), throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2
  });
  assert.equal(sentinel.confidenceActions.some(item => item.includes('classify') || item.includes('size')), true);
});

test('observed history is an exact, adjacent and internally consistent aggregate', () => {
  const zero = weekStart => ({ weekStart, closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} });
  const invalidHistories = [
    ['2026-07-06', '2026-07-27', '2030-01-07'].map(zero),
    ['2026-07-13', '2026-07-20', '2026-07-27'].map(weekStart => ({ ...zero(weekStart), closedUnitsByDomain: { analysis: Infinity } })),
    ['2026-07-20', '2026-07-27', '2026-08-03'].map(zero),
    ['2020-01-06', '2020-01-13', '2020-01-20'].map(zero),
    [zero('2026-07-13'), zero('2026-07-20'), { weekStart: '2026-07-27', closed: 0, closedByDomain: {}, closedUnitsByDomain: {} }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), note: 'invented' }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closedByDomain: { invented: 0 } }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closedBySize: { huge: 0 } }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closedUnitsByDomain: { invented: 0 } }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closed: 0.5 }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closed: 1, closedByDomain: {}, closedBySize: { small: 1 }, closedUnitsByDomain: { analysis: 1 } }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closed: 1, closedByDomain: { analysis: 1 }, closedBySize: {}, closedUnitsByDomain: { analysis: 1 } }],
    [zero('2026-07-13'), zero('2026-07-20'), { ...zero('2026-07-27'), closed: 1, closedByDomain: { analysis: 1 }, closedBySize: { large: 1 }, closedUnitsByDomain: { analysis: 2 } }]
  ];
  for (const weeks of invalidHistories) {
    assert.throws(() => forecastCompletion({
      actions: new Map([action('ACT-970')]), throughputHistory: { completeWeeks: 3, weeks }, capacityCalendar: calendar(), integrationBuffer: 0.2
    }), error => error instanceof ResearchOSError && error.code === 'VALIDATION');
  }
});

test('observed domain units must be integer sums attainable from that domain closure count', () => {
  const zero = weekStart => ({ weekStart, closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} });
  const invalidLastWeeks = [
    { ...zero('2026-07-27'), closed: 1, closedByDomain: { analysis: 1 }, closedBySize: { large: 1 }, closedUnitsByDomain: { writing: 4 } },
    { ...zero('2026-07-27'), closed: 2, closedByDomain: { analysis: 1, writing: 1 }, closedBySize: { large: 1, small: 1 }, closedUnitsByDomain: { analysis: 3, writing: 2 } },
    { ...zero('2026-07-27'), closed: 3, closedByDomain: { analysis: 2, writing: 1 }, closedBySize: { large: 2, small: 1 }, closedUnitsByDomain: { analysis: 7, writing: 2 } },
    { ...zero('2026-07-27'), closed: 2, closedByDomain: { analysis: 1, writing: 1 }, closedBySize: { medium: 2 }, closedUnitsByDomain: { analysis: 1.5, writing: 2.5 } }
  ];
  for (const last of invalidLastWeeks) {
    assert.throws(() => forecastCompletion({
      actions: new Map([action('ACT-975')]),
      throughputHistory: { completeWeeks: 3, weeks: [zero('2026-07-13'), zero('2026-07-20'), last] },
      capacityCalendar: calendar(), integrationBuffer: 0.2
    }), error => error instanceof ResearchOSError && error.code === 'VALIDATION');
  }

  const valid = { ...zero('2026-07-27'), closed: 3, closedByDomain: { analysis: 2, writing: 1 }, closedBySize: { large: 1, medium: 1, small: 1 }, closedUnitsByDomain: { analysis: 5, writing: 2 } };
  assert.equal(forecastCompletion({
    actions: new Map([action('ACT-976')]),
    throughputHistory: { completeWeeks: 3, weeks: [zero('2026-07-13'), zero('2026-07-20'), valid] },
    capacityCalendar: calendar(), integrationBuffer: 0.2
  }).method, 'observed');
});

test('forecast input wrapper has an exact enumerable own-property allowlist', () => {
  const base = () => ({
    actions: new Map([action('ACT-977')]), throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar()
  });
  assert.equal(forecastCompletion(base()).method, 'scenario');
  const extra = base(); extra.extra = 'undeclared';
  const hidden = base(); Object.defineProperty(hidden, 'hidden', { value: 'authority', enumerable: false });
  const symbol = base(); symbol[Symbol('authority')] = true;
  let hits = 0; const accessor = base(); Object.defineProperty(accessor, 'integrationBuffer', { enumerable: true, get() { hits += 1; return 0.2; } });
  for (const input of [extra, hidden, symbol, accessor, new Proxy(base(), {})]) {
    assert.throws(() => forecastCompletion(input), error => error instanceof ResearchOSError && error.code === 'VALIDATION');
  }
  assert.equal(hits, 0);
});

test('handoff rejects noncanonical, schema-invalid, or lifecycle-invalid Result/Evidence authority', () => {
  const closed = history('closed', [
    { from: 'inbox', to: 'defined', at: '2026-07-01T00:00:01Z', reason: 'defined' },
    { from: 'defined', to: 'ready', at: '2026-07-01T00:00:02Z', reason: 'ready' },
    { from: 'ready', to: 'in_progress', at: '2026-07-01T00:00:03Z', reason: 'started' },
    { from: 'in_progress', to: 'closed', at: '2026-07-02T00:00:00Z', reason: 'closed' }
  ]);
  const validResult = resultAttributes('RES-990', closed);
  const validEvidence = evidenceAttributes('EVD-990', closed, ['RES-990']);
  const cases = [
    new Map([record('archive/RES-990.md', validResult), record('evidence/packets/EVD-990.md', validEvidence)]),
    new Map([record('experiments/results/RES-990.md', { ...validResult, run: 42 }), record('evidence/packets/EVD-990.md', validEvidence)]),
    new Map([record('experiments/results/RES-990.md', validResult), record('archive/EVD-990.md', validEvidence)]),
    new Map([record('experiments/results/RES-990.md', validResult), record('evidence/packets/EVD-990.md', { ...validEvidence, interpretation: 42 })]),
    new Map([record('experiments/results/RES-990.md', validResult), record('evidence/packets/EVD-990.md', { ...validEvidence, status_history: [] })])
  ];
  for (const catalog of cases) {
    assert.throws(() => summarizeActions(catalog, calendar()), error => error instanceof ResearchOSError && error.code === 'VALIDATION');
  }
});

test('public catalog boundary rejects array, key/path mismatch, duplicate IDs, archive Actions, accessors and cycles without executing code', () => {
  assert.throws(() => summarizeActions([action('ACT-980')[1]], calendar()), error => error.code === 'VALIDATION');
  assert.throws(() => summarizeActions(new Map([['wrong', action('ACT-981')[1]]]), calendar()), error => error.code === 'VALIDATION');
  const duplicate = action('ACT-982');
  const copy = record('plans/actions/ACT-982-copy.md', { ...duplicate[1].attributes });
  assert.throws(() => summarizeActions(new Map([duplicate, copy]), calendar()), error => error.code === 'VALIDATION');
  const dependent = action('ACT-985', { dependencies: ['ACT-982'] });
  assert.throws(
    () => forecastCompletion({ actions: new Map([dependent, duplicate, copy]), throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar() }),
    error => error.code === 'VALIDATION' && error.details.some(item => item.code === 'DEPENDENCY_AMBIGUOUS' && item.path === dependent[0])
  );
  const archived = action('ACT-983'); archived[1].path = 'archive/ACT-983.md';
  assert.throws(() => summarizeActions(new Map([['archive/ACT-983.md', archived[1]]]), calendar()), error => error.code === 'VALIDATION');
  let hits = 0;
  const input = {};
  Object.defineProperty(input, 'actions', { enumerable: true, get() { hits += 1; return new Map(); } });
  Object.assign(input, { throughputHistory: { completeWeeks: 0, weeks: [] }, capacityCalendar: calendar(), integrationBuffer: 0.2 });
  assert.throws(() => forecastCompletion(input), error => error.code === 'VALIDATION');
  assert.equal(hits, 0);
  const cyclic = action('ACT-984');
  cyclic[1].attributes.risks = []; cyclic[1].attributes.risks.push(cyclic[1].attributes);
  assert.throws(() => summarizeActions(new Map([cyclic]), calendar()), error => error.code === 'VALIDATION');
});

function retiredAction(id, status, overrides = {}) {
  return action(id, { ...history(status, [{ from: 'inbox', to: status, at: '2026-08-04T00:00:00Z', reason: 'Approved project direction.' }]), ...overrides });
}

test('retired and deferred Actions leave remaining scope without becoming successful closures', () => {
  const active = action('ACT-980', { created: '2026-08-03T00:00:00Z' });
  const catalog = new Map([active,
    retiredAction('ACT-981', 'cancelled', { created: '2026-08-03T00:00:00Z', dependencies: ['ACT-999'] }),
    retiredAction('ACT-982', 'deferred', { created: '2026-08-03T00:00:00Z' }),
    retiredAction('ACT-983', 'superseded', { created: '2026-08-03T00:00:00Z' })
  ]);
  const summary = summarizeActions(catalog, calendar());
  assert.equal(summary.total, 4);
  assert.equal(summary.remaining, 1);
  assert.deepEqual(summary.scopeAdded.map(item => item.actionId), ['ACT-980']);
  assert.equal(summary.throughputHistory.weeks.reduce((sum, week) => sum + week.closed, 0), 0);
  const forecast = actions => forecastCompletion({ actions, capacityCalendar: calendar(), throughputHistory: { completeWeeks: 0, weeks: [] } });
  assert.deepEqual(forecast(catalog).median, forecast(new Map([active])).median);
  assert.equal(forecast(catalog).issues.some(item => item.code === 'DEPENDENCY_MISSING'), false);
});

test('a scheduled Action depending on a retired or deferred Action has no completion date', () => {
  for (const status of ['cancelled', 'superseded', 'deferred']) {
    const forecast = forecastCompletion({ actions: new Map([
      action('ACT-984', { dependencies: ['ACT-985'] }), retiredAction('ACT-985', status)
    ]), capacityCalendar: calendar(), throughputHistory: { completeWeeks: 0, weeks: [] } });
    assert.equal(forecast.median.latest, null);
    assert.equal(forecast.issues.some(item => item.code === 'DEPENDENCY_UNRESOLVED'), true);
  }
});

test('accepted Artifact dependencies do not require closing the producer Action', () => {
  const acceptedAt = '2026-07-20T00:00:00Z';
  const artifact = record('artifacts/ART-001.md', {
    schema_version: 1, type: 'artifact', id: 'ART-001', created: baseTime, updated: acceptedAt,
    status: 'closed', status_history: [{ from: 'inbox', to: 'defined', at: baseTime, reason: 'Defined.' }, { from: 'defined', to: 'ready', at: '2026-07-06T00:00:01Z', reason: 'Ready.' }, { from: 'ready', to: 'in_progress', at: '2026-07-06T00:00:02Z', reason: 'Produced.' }, { from: 'in_progress', to: 'closed', at: acceptedAt, reason: 'Accepted output.' }], verified_at: acceptedAt,
    producer_action: 'ACT-986', file: 'outputs/model.bin', sha256: 'a'.repeat(64), acceptance: { actor: 'Researcher', at: acceptedAt, evidence: 'Model checked.' }
  });
  const inputs = { actions: new Map([action('ACT-986'), action('ACT-987', { dependencies: ['ART-001'] }), artifact]), capacityCalendar: calendar(), throughputHistory: { completeWeeks: 0, weeks: [] } };
  assert.notEqual(forecastCompletion(inputs).median.latest, null);
  artifact[1].attributes = { ...artifact[1].attributes, status: 'inbox', status_history: [], acceptance: null, sha256: null };
  delete artifact[1].attributes.verified_at;
  assert.equal(forecastCompletion({ ...inputs, actions: new Map([action('ACT-987', { dependencies: ['ART-001'] }), artifact]) }).median.latest, null);
});

test('blocker summaries preserve unknown times and resolved historical causes', () => {
  const blocker = { id: 'BLK-1', category: 'resource', critical_path: true, root_cause: 'Unknown.', resolution: null, description: 'Await approved GPU.', owner: 'Researcher', since: null, next_unblock_action: 'Check allocation.', review_at: null, status: 'active', resolved_at: null };
  const catalog = new Map([action('ACT-988', { updated: '2026-08-04T00:00:00Z', blockers: [blocker, { ...blocker, id: 'BLK-2', status: 'resolved', since: '2026-07-20T00:00:00Z', resolved_at: '2026-07-22T00:00:00Z', root_cause: 'Queue exhausted.', resolution: 'Allocation approved.' }] })]);
  const summary = summarizeActions(catalog, calendar());
  assert.equal(summary.blockers[0].ageDays, null);
  assert.equal(summary.blockers[0].category, 'resource');
  assert.equal(summary.blockers[0].criticalPath, true);
  assert.equal(summary.issues.some(item => item.code === 'BLOCKER_DATE_INVALID'), false);
  assert.equal(summary.blockerHistory[0].durationDays, 2);
  assert.equal(summary.blockerHistory[0].rootCause, 'Queue exhausted.');
});
