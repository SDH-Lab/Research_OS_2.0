import { actionAttention } from '../session/attention.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { ResearchOSError } from '../lib/errors.js';
import { safeJoin } from '../lib/fs.js';
import { deepFreeze } from '../lib/readonly.js';
import { isProjectInternalDirectory } from '../lib/project-tree.js';
import { discoverWritingCatalog } from '../records/catalog.js';
import { validateProject } from '../validation/validator.js';
import { loadProject } from '../project/project.js';
import { computeConcernCoverage } from '../writing/response.js';
import { forecastCompletion, summarizeActions } from './forecast.js';

export const GENERATED_FILES = Object.freeze([
  'generated/coverage.md',
  'generated/dashboard.md',
  'generated/exception-inbox.md',
  'generated/forecast.json',
  'generated/generation-manifest.json'
]);
const GENERATED_VIEWS = Object.freeze(GENERATED_FILES.slice(0, -1));
const GENERATED_NAMES = Object.freeze({
  coverage: GENERATED_FILES[0],
  dashboard: GENERATED_FILES[1],
  'exception-inbox': GENERATED_FILES[2],
  forecast: GENERATED_FILES[3],
  manifest: GENERATED_FILES[4]
});
const OPEN_STATUSES = new Set(['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'reopened']);

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestGenerationInputs(coreVersion, inputs) {
  return sha256(`${coreVersion}\n${inputs.map(item => `${item.path}\0${item.sha256}`).join('\n')}\n`);
}

function relativePath(root, path) {
  return relative(root, path).split(/[/\\]/u).join('/');
}

export async function canonicalInputSnapshot(projectRoot) {
  const root = resolve(projectRoot);
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (entry.isDirectory() && isProjectInternalDirectory(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(relativePath(root, path));
      else if (entry.isSymbolicLink()) throw new ResearchOSError('VALIDATION', `Canonical snapshot refuses symbolic link: ${relativePath(root, path)}`);
    }
  }
  await visit(root);
  const inputs = [];
  for (const path of paths.sort((left, right) => left.localeCompare(right, 'en'))) {
    inputs.push({ path, sha256: sha256(await readFile(safeJoin(root, path))) });
  }
  return inputs;
}

function projectAndPlan(catalog) {
  const records = [...catalog.values()];
  const projectRecord = records.find(record => record.path === 'PROJECT.md' && record.attributes.type === 'project');
  if (!projectRecord) throw new ResearchOSError('VALIDATION', 'Validated project has no canonical PROJECT.md');
  const plan = catalog.get(projectRecord.attributes.active_plan);
  if (!plan || plan.attributes.type !== 'exec_plan') throw new ResearchOSError('VALIDATION', 'Validated project has no canonical Active ExecPlan');
  return { projectRecord, plan };
}

function capacityCalendar(project) {
  const settings = project.forecast_settings;
  return {
    asOf: settings.as_of,
    timezone: settings.timezone,
    defaultWeeklyUnits: settings.default_weekly_capacity,
    weeks: settings.capacity_calendar.map(item => ({ weekStart: item.week_start, availableUnits: item.available_units, reason: item.reason }))
  };
}

async function assertValidProject(projectRoot) {
  const report = await validateProject(projectRoot);
  if (!report.ok) {
    const codes = [...new Set(report.issues.map(item => item.code))].sort().join(', ');
    throw new ResearchOSError('VALIDATION', `Project validation failed with ${report.issues.length} issue(s): ${codes}`, report.issues);
  }
  return report;
}

function md(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/([\\`*_[\]<>|])/gu, '\\$1');
}

function link(path) {
  const encoded = String(path).split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `[${md(path)}](../${encoded})`;
}

function renderRange(range) {
  if (!range || range.earliest === null || range.latest === null) return 'withheld';
  return range.earliest === range.latest ? range.earliest : `${range.earliest} – ${range.latest}`;
}

function renderCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${md(key)}=${value}`).join(', ');
}

function renderDashboard(projectRecord, plan, summary, forecast) {
  const historyRows = summary.blockerHistory.map(item => `- ${link(item.path)} — ${md(item.description)}; ${md(item.category)}; ${item.durationDays ?? 'unknown'} days; resolution: ${md(item.resolution ?? 'unknown')}`).join('\n') || '- None recorded.';
  const blockerRows = summary.blockers.length === 0
    ? '- None.'
    : summary.blockers.map(item => `- ${link(item.path)} — ${md(item.description)} (${item.ageDays ?? 'unknown'} days; owner ${md(item.owner)}; next: ${md(item.nextUnblockAction)})`).join('\n');
  const reasons = forecast.changeReasons.map(item => `- ${md(item)}`).join('\n') || '- None recorded.';
  const confidenceActions = forecast.confidenceActions.map(item => `- ${md(item)}`).join('\n') || '- None required.';
  const remainingRows = summary.remainingItems.length === 0
    ? '- None.'
    : summary.remainingItems.map(item => `- ${link(item.path)} — ${md(item.domain)}/${md(item.size)}; ${md(item.status)}; next: ${md(item.nextStep)}`).join('\n');
  const handoffRows = [
    ...summary.handoff.completed.map(item => `- completed: ${link(item.resultPath)} → ${link(item.evidencePath)} (${item.delayDays ?? 'unknown'} days)`),
    ...summary.handoff.pending.map(item => `- pending: ${link(item.resultPath)} — ${md(item.reason)}`)
  ].join('\n') || '- None.';
  const medianDelay = summary.handoff.medianDelayDays === null ? 'not available' : `${summary.handoff.medianDelayDays} days`;
  return `# Research OS Dashboard\n\nAuthority: ${link(projectRecord.path)} and ${link(plan.path)}. Generated from canonical records; delete and rebuild at any time.\n\n## Foreground\n\n- Objective: ${md(projectRecord.attributes.foreground_objective ?? 'Not set')}\n- Next action: ${md(plan.attributes.resume_point.next_action)}\n- As of: ${md(projectRecord.attributes.forecast_settings.as_of)} (${md(projectRecord.attributes.forecast_settings.timezone)})\n\n## Remaining Action units\n\n- Remaining Actions: ${summary.remaining} / ${summary.total}\n- By domain: ${renderCounts(summary.byDomain)}\n- By size: ${renderCounts(summary.bySize)}\n- In-progress Actions: ${summary.inProgress}\n- Current-week scope additions: ${summary.scopeAdded.length}\n- Reopen transitions: ${summary.reopened.transitions}; current reopened: ${summary.reopened.current}; rate: ${summary.reopened.rate.toFixed(2)}\n\n### Remaining Action sources\n\n${remainingRows}\n\n## Blockers\n\n${blockerRows}\n\n## Resolved blockers\n\n${historyRows}\n\n## Forecast\n\n- Optimistic: ${renderRange(forecast.optimistic)}\n- Median: ${renderRange(forecast.median)}\n- Conservative: ${renderRange(forecast.conservative)}\n- Method: ${md(forecast.method)}\n- Confidence: ${md(forecast.confidence)}\n\n### Confidence actions\n\n${confidenceActions}\n\n### Change reasons\n\n${reasons}\n\n## Result Acceptance → Evidence Handoff\n\n- Handoff completed: ${summary.handoff.completed.length}\n- Handoff pending: ${summary.handoff.pending.length}\n- Median delay: ${medianDelay}\n\n### Handoff sources\n\n${handoffRows}\n\n## Drill-down\n\n- Exception Inbox: [generated/exception-inbox.md](exception-inbox.md)\n- Coverage: [generated/coverage.md](coverage.md)\n- Forecast data: [generated/forecast.json](forecast.json)\n`;
}

function exception(code, path, message, relatedIds = []) {
  return { code, path, message, relatedIds };
}

function uniqueExceptions(items) {
  const unique = new Map();
  for (const item of items) {
    const normalized = { code: item.code, path: item.path, message: item.message, relatedIds: item.relatedIds ?? [] };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'en'));
}

function deriveExceptions(catalog, plan, summary, coverage, forecast) {
  const items = summary.issues.map(item => exception(item.code, item.path, item.message, item.relatedIds));
  for (const item of actionAttention(catalog, catalog.get('PROJECT.md').attributes.forecast_settings.as_of)) {
    if (item.code !== 'ACTION_BLOCKED') items.push(exception(item.code, item.path, item.message, [item.actionId]));
  }
  for (const item of forecast.issues) items.push(exception(item.code, item.path, item.message, item.relatedIds));
  for (const blocker of summary.blockers) items.push(exception('ACTION_BLOCKED', blocker.path, `${blocker.description}; next: ${blocker.nextUnblockAction}`, [blocker.actionId]));
  const actionReopens = new Map();
  for (const item of summary.reopened.items) actionReopens.set(item.actionId, [...(actionReopens.get(item.actionId) ?? []), item]);
  for (const [actionId, transitions] of actionReopens) {
    const latest = transitions.at(-1);
    items.push(exception('RECORD_REOPENED', latest.path, `${transitions.length} recorded reopen transition(s); latest reason: ${latest.reason ?? 'not recorded'}.`, [actionId]));
  }
  for (const item of summary.handoff.pending) items.push(exception('EVIDENCE_HANDOFF_PENDING', item.resultPath, `Accepted Result has ${item.reason.replaceAll('_', ' ')}.`, [item.resultId]));
  for (const record of catalog.values()) {
    const history = Array.isArray(record.attributes.status_history) ? record.attributes.status_history : [];
    if (record.attributes.type !== 'action' && (record.attributes.status === 'reopened' || history.some(entry => entry?.from === 'closed' && entry?.to === 'reopened'))) {
      items.push(exception('RECORD_REOPENED', record.path, 'Record has a closed-to-reopened transition.', [record.attributes.id]));
    }
    if (['incident', 'risk'].includes(record.attributes.type) && OPEN_STATUSES.has(record.attributes.status)) {
      items.push(exception(record.attributes.type === 'risk' ? 'OPEN_RISK' : 'OPEN_INCIDENT', record.path, record.attributes.fact_or_risk, [record.attributes.id]));
    }
  }
  if (Array.isArray(plan.attributes.blockers)) {
    for (const blocker of plan.attributes.blockers.filter(value => typeof value === 'string' && value.trim().length > 0)) {
      items.push(exception('ACTIVE_PLAN_BLOCKER', plan.path, blocker, [plan.attributes.id]));
    }
  }
  if (coverage.status === 'enabled') {
    for (const item of coverage.report.issues ?? []) items.push(exception(item.code, item.path, item.message, item.relatedIds));
    for (const concern of Object.values(coverage.report.concerns ?? {})) {
      for (const item of concern.issues ?? []) items.push(exception(item.code, item.path, item.message, item.relatedIds));
    }
  }
  return uniqueExceptions(items);
}

function renderExceptions(items) {
  const rows = items.length === 0 ? '- No exceptions.' : items.map(item => `- \`${String(item.code).replaceAll('`', '')}\` — ${link(item.path)} — ${md(item.message)}`).join('\n');
  return `# Exception Inbox\n\nDerived view only; canonical records remain authoritative.\n\n${rows}\n`;
}

function renderCoverage(coverage) {
  if (coverage.status === 'not_applicable') {
    return '# Reviewer Coverage\n\nstatus: not_applicable\n\nThe reviews module is disabled; reviewer Concern coverage is not applicable to this project.\n';
  }
  const report = coverage.report;
  const concernRows = Object.values(report.concerns ?? {}).map(item => `- ${link(item.path)} — ${item.closable ? 'closable' : 'not closable'}`).join('\n') || '- None.';
  const issues = [
    ...(report.issues ?? []),
    ...Object.values(report.concerns ?? {}).flatMap(item => item.issues ?? [])
  ];
  const issueRows = uniqueExceptions(issues).map(item => `- **${md(item.code)}** — ${link(item.path)} — ${md(item.message)}`).join('\n') || '- None.';
  return `# Reviewer Coverage\n\nstatus: enabled\n\n- Concern count: ${Object.keys(report.concerns ?? {}).length}\n- Overall closable: ${report.closable}\n\n## Concerns\n\n${concernRows}\n\n## Candidate and coverage issues\n\n${issueRows}\n`;
}

async function deriveProjectState(projectRoot, includeInputs = false) {
  const inputsBefore = includeInputs ? await canonicalInputSnapshot(projectRoot) : null;
  await assertValidProject(projectRoot);
  const catalog = await discoverWritingCatalog(projectRoot);
  const { projectRecord, plan } = projectAndPlan(catalog);
  const calendar = capacityCalendar(projectRecord.attributes);
  const summary = summarizeActions(catalog, calendar);
  const forecast = forecastCompletion({
    actions: catalog,
    throughputHistory: summary.throughputHistory,
    capacityCalendar: calendar,
    integrationBuffer: projectRecord.attributes.forecast_settings.integration_buffer
  });
  const coverage = projectRecord.attributes.modules.includes('reviews')
    ? { status: 'enabled', report: computeConcernCoverage(catalog) }
    : { status: 'not_applicable', report: null };
  if (includeInputs) {
    const inputsAfter = await canonicalInputSnapshot(projectRoot);
    if (JSON.stringify(inputsAfter) !== JSON.stringify(inputsBefore)) throw new ResearchOSError('VALIDATION', 'Canonical authority changed while views were being derived; retry build');
  }
  return { catalog, projectRecord, plan, summary, forecast, coverage, inputs: inputsBefore };
}

/** Calculate a canonical forecast without reading generated state or wall-clock time. */
export async function calculateForecastForProject(projectRoot) {
  const state = await deriveProjectState(projectRoot);
  return deepFreeze(structuredClone(state.forecast));
}

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function preflightOutputs(projectRoot) {
  const directory = safeJoin(projectRoot, 'generated');
  const directoryStat = await statOrNull(directory);
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) throw new ResearchOSError('VALIDATION', 'generated/ must be a real directory');
  const originals = new Map();
  for (const path of GENERATED_FILES) {
    const target = safeJoin(projectRoot, path);
    const stat = await statOrNull(target);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ResearchOSError('VALIDATION', `Generated target must be absent or a regular file: ${path}`);
    originals.set(path, stat ? { existed: true, bytes: await readFile(target) } : { existed: false, bytes: null });
  }
  return { directory, directoryExisted: Boolean(directoryStat), originals };
}

async function cleanupStages(stages) {
  for (const stage of stages.values()) {
    try { await unlink(stage); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function restoreOutputs(projectRoot, originals) {
  for (const path of GENERATED_FILES) {
    const target = safeJoin(projectRoot, path);
    const original = originals.get(path);
    if (original.existed) {
      const rollback = join(safeJoin(projectRoot, 'generated'), `.research-os-rollback-${randomUUID()}-${basename(path)}`);
      await writeFile(rollback, original.bytes, { flag: 'wx' });
      await rename(rollback, target);
    } else {
      const stat = await statOrNull(target);
      if (stat?.isFile() && !stat.isSymbolicLink()) await unlink(target);
    }
  }
}

function sameInputs(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/** Build all five deletable views as one rollback-capable transaction. */
export async function buildViews(projectRoot, options = {}) {
  const state = await deriveProjectState(projectRoot, true);
  const inputs = state.inputs;
  const sourceDigest = digestGenerationInputs(state.projectRecord.attributes.core_version, inputs);
  const exceptions = deriveExceptions(state.catalog, state.plan, state.summary, state.coverage, state.forecast);
  const outputs = new Map([
    ['generated/coverage.md', renderCoverage(state.coverage)],
    ['generated/dashboard.md', renderDashboard(state.projectRecord, state.plan, state.summary, state.forecast)],
    ['generated/exception-inbox.md', renderExceptions(exceptions)],
    ['generated/forecast.json', stableJson(state.forecast)]
  ]);
  const manifest = {
    schemaVersion: 1,
    files: [...GENERATED_FILES],
    inputs,
    outputs: GENERATED_VIEWS.map(path => ({ path, sha256: sha256(outputs.get(path)) })),
    sourceDigest,
    coreVersion: state.projectRecord.attributes.core_version
  };
  if (!isValidGenerationManifest(manifest)) throw new ResearchOSError('VALIDATION', 'Generated manifest failed its own contract before write');
  outputs.set('generated/generation-manifest.json', stableJson(manifest));
  const preflight = await preflightOutputs(projectRoot);
  const stages = new Map();
  const committedResult = deepFreeze({ files: [...GENERATED_FILES], sourceDigest });
  try {
    if (!preflight.directoryExisted) await mkdir(preflight.directory);
    for (const path of GENERATED_FILES) {
      const stage = join(preflight.directory, `.research-os-stage-${randomUUID()}-${basename(path)}`);
      await writeFile(stage, outputs.get(path), { encoding: 'utf8', flag: 'wx' });
      stages.set(path, stage);
    }
    await options.hooks?.afterStage?.({ projectRoot, paths: [...GENERATED_FILES] });
    const stagedInputs = await canonicalInputSnapshot(projectRoot);
    if (!sameInputs(stagedInputs, inputs)) throw new ResearchOSError('VALIDATION', 'Canonical authority changed after staging; transaction rolled back');

    // The manifest is the terminal commit marker. Originals are already held in
    // memory, so withdraw the old manifest without creating post-commit debris.
    if (preflight.originals.get(GENERATED_NAMES.manifest).existed) {
      await unlink(safeJoin(projectRoot, GENERATED_NAMES.manifest));
    }
    for (const [index, path] of GENERATED_VIEWS.entries()) {
      await options.hooks?.beforePublish?.({ projectRoot, path, index });
      await rename(stages.get(path), safeJoin(projectRoot, path));
      stages.delete(path);
      await options.hooks?.afterPublish?.({ projectRoot, path, index });
    }
    await options.hooks?.beforePublish?.({ projectRoot, path: GENERATED_NAMES.manifest, index: GENERATED_FILES.length - 1 });
    const finalInputs = await canonicalInputSnapshot(projectRoot);
    if (!sameInputs(finalInputs, inputs)) throw new ResearchOSError('VALIDATION', 'Canonical authority changed during publication; transaction rolled back');
    await rename(stages.get(GENERATED_NAMES.manifest), safeJoin(projectRoot, GENERATED_NAMES.manifest));
    stages.delete(GENERATED_NAMES.manifest);
    return committedResult;
  } catch (error) {
    let rollbackError;
    try { await restoreOutputs(projectRoot, preflight.originals); } catch (caught) { rollbackError = caught; }
    try { await cleanupStages(stages); } catch (caught) { rollbackError ??= caught; }
    if (!preflight.directoryExisted) {
      try { await rmdir(preflight.directory); } catch (caught) { if (caught.code !== 'ENOTEMPTY' && caught.code !== 'ENOENT') rollbackError ??= caught; }
    }
    if (rollbackError) throw new ResearchOSError('VALIDATION', `View transaction failed and rollback was incomplete: ${rollbackError.message}`);
    if (error instanceof ResearchOSError) throw error;
    throw new ResearchOSError('VALIDATION', `View transaction rolled back: ${error.message}`);
  } finally {
    // A successful manifest rename deletes the final stage entry, so no
    // fallible filesystem work executes after the commit point.
    if (stages.size > 0) await cleanupStages(stages);
  }
}

export function isValidGenerationManifest(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.files)) return false;
  if (Object.keys(value).sort().join(',') !== 'coreVersion,files,inputs,outputs,schemaVersion,sourceDigest') return false;
  if (value.files.length !== GENERATED_FILES.length || new Set(value.files).size !== GENERATED_FILES.length) return false;
  if (!value.files.every((path, index) => path === GENERATED_FILES[index])) return false;
  if (typeof value.coreVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.coreVersion) || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceDigest)) return false;
  if (!Array.isArray(value.inputs) || !Array.isArray(value.outputs) || value.outputs.length !== GENERATED_VIEWS.length) return false;
  if (!value.outputs.every((output, index) => output && !Array.isArray(output) && typeof output === 'object'
    && Object.keys(output).sort().join(',') === 'path,sha256'
    && output.path === GENERATED_VIEWS[index]
    && /^[a-f0-9]{64}$/u.test(output.sha256))) return false;
  const seen = new Set();
  let previous = null;
  for (const input of value.inputs) {
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'path,sha256') return false;
    const parts = typeof input.path === 'string' ? input.path.split('/') : [];
    if (typeof input.path !== 'string' || input.path.length === 0 || /[\0\r\n]/u.test(input.path) || input.path.startsWith('/') || input.path.includes('\\') || parts.some(part => part === '' || part === '.' || part === '..' || isProjectInternalDirectory(part))) return false;
    if (input.path === 'generated' || input.path.startsWith('generated/')) return false;
    if (!/^[a-f0-9]{64}$/u.test(input.sha256) || seen.has(input.path) || (previous !== null && previous.localeCompare(input.path, 'en') >= 0)) return false;
    seen.add(input.path);
    previous = input.path;
  }
  return digestGenerationInputs(value.coreVersion, value.inputs) === value.sourceDigest;
}

/** Verify one manifest against the same canonical snapshot and output contract used by build/show/clean. */
export async function verifyGenerationSnapshot(projectRoot, manifest) {
  const issues = [];
  if (!isValidGenerationManifest(manifest)) {
    return deepFreeze({ ok: false, issues: [{ code: 'GENERATED_VIEW_INVALID', path: 'generated/generation-manifest.json', message: 'Generation manifest failed its exact schema and digest contract.' }] });
  }
  const project = await loadProject(projectRoot);
  if (manifest.coreVersion !== project.core_version) {
    issues.push({ code: 'GENERATED_VIEW_INVALID', path: 'generated/generation-manifest.json#/coreVersion', message: 'Generation manifest Core pin differs from PROJECT.core_version.' });
  }
  let currentInputs;
  try { currentInputs = await canonicalInputSnapshot(projectRoot); }
  catch (error) {
    issues.push({ code: 'GENERATED_VIEW_INVALID', path: 'generated/generation-manifest.json#/inputs', message: error.message, unsafe: true });
    return deepFreeze({ ok: false, issues });
  }
  if (JSON.stringify(currentInputs) !== JSON.stringify(manifest.inputs)) {
    issues.push({ code: 'GENERATED_VIEW_STALE', path: 'generated/generation-manifest.json#/inputs', message: 'Current canonical input inventory differs from the committed generation snapshot.' });
  }
  for (const output of manifest.outputs) {
    try {
      const target = safeJoin(projectRoot, output.path);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        issues.push({ code: 'GENERATED_VIEW_INVALID', path: output.path, message: 'Generated output must be a regular non-symlink file.', unsafe: true });
        continue;
      }
      if (sha256(await readFile(target)) !== output.sha256) {
        issues.push({ code: 'GENERATED_VIEW_TAMPERED', path: output.path, message: 'Generated output hash differs from its manifest.' });
      }
    } catch (error) {
      issues.push({ code: error.code === 'ENOENT' ? 'GENERATED_VIEW_MISSING' : 'GENERATED_VIEW_INVALID', path: output.path, message: error.message, ...(error.code === 'ENOENT' ? {} : { unsafe: true }) });
    }
  }
  return deepFreeze({ ok: issues.length === 0, issues });
}

/** Remove only exact, regular files named by an untampered generation manifest. */
export async function cleanViews(projectRoot) {
  let manifestPath;
  let manifest;
  try {
    manifestPath = safeJoin(projectRoot, GENERATED_NAMES.manifest);
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchOSError('VALIDATION', 'Generation manifest is not a regular file');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ResearchOSError('RECORD_NOT_FOUND', 'Generation manifest not found');
    if (error instanceof SyntaxError) throw new ResearchOSError('VALIDATION', 'Generation manifest is not valid JSON');
    if (error instanceof ResearchOSError) {
      if (error.code === 'VALIDATION') throw error;
      throw new ResearchOSError('VALIDATION', `Generation manifest preflight failed: ${error.message}`);
    }
    throw error;
  }
  if (!isValidGenerationManifest(manifest)) throw new ResearchOSError('VALIDATION', 'Generation manifest files must exactly equal the five known outputs');
  const targets = [];
  try {
    for (const path of manifest.files) {
      const target = safeJoin(projectRoot, path);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchOSError('VALIDATION', `Generated output is not a regular file: ${path}`);
      const output = manifest.outputs.find(item => item.path === path);
      if (output && sha256(await readFile(target)) !== output.sha256) throw new ResearchOSError('VALIDATION', `Generated output hash does not match manifest: ${path}`);
      targets.push({ path, target });
    }
  } catch (error) {
    if (error instanceof ResearchOSError) {
      if (error.code === 'VALIDATION') throw error;
      throw new ResearchOSError('VALIDATION', `Generated output preflight failed: ${error.message}`);
    }
    if (error.code === 'ENOENT') throw new ResearchOSError('VALIDATION', 'Generation manifest names a missing output');
    throw new ResearchOSError('VALIDATION', `Generated output preflight failed: ${error.message}`);
  }
  const manifestTarget = targets.find(item => item.path === GENERATED_NAMES.manifest);
  for (const item of targets.filter(item => item !== manifestTarget)) await unlink(item.target);
  await unlink(manifestTarget.target);
  return deepFreeze({ removed: [...GENERATED_FILES] });
}

/** Read one allowlisted generated view by logical name. */
export async function showView(projectRoot, name) {
  if (!Object.hasOwn(GENERATED_NAMES, name)) throw new ResearchOSError('USAGE', `Unknown view name: ${name}`);
  const path = GENERATED_NAMES[name];
  try {
    const manifestPath = safeJoin(projectRoot, GENERATED_NAMES.manifest);
    const manifestBefore = await readFile(manifestPath, 'utf8');
    let manifest;
    try { manifest = JSON.parse(manifestBefore); } catch { throw new ResearchOSError('VALIDATION', 'Generation manifest is not valid JSON'); }
    if (!isValidGenerationManifest(manifest)) throw new ResearchOSError('VALIDATION', 'Generation manifest failed its complete contract');
    const target = safeJoin(projectRoot, path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchOSError('VALIDATION', `Generated view is not a regular file: ${path}`);
    const content = await readFile(target, 'utf8');
    const output = manifest.outputs.find(item => item.path === path);
    if (output && sha256(content) !== output.sha256) throw new ResearchOSError('VALIDATION', `Generated view hash does not match manifest: ${path}`);
    const manifestAfter = await readFile(manifestPath, 'utf8');
    if (manifestAfter !== manifestBefore) throw new ResearchOSError('VALIDATION', 'Generation manifest changed while the view was being read');
    return deepFreeze({ name, path, content });
  } catch (error) {
    if (error.code === 'ENOENT') throw new ResearchOSError('RECORD_NOT_FOUND', `Generated view not found: ${name}`);
    throw error;
  }
}
