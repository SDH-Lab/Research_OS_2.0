import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { ResearchOSError } from '../lib/errors.js';
import { readUtf8, safeJoin, writeUtf8Atomic } from '../lib/fs.js';
import { safeDataClone } from '../lib/safe-data.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { discoverRecordCandidates } from '../records/catalog.js';
import { isTerminalActionStatus, isScheduledActionStatus } from '../records/action-state.js';
import { schemaForRecordType, validateRecord, validateStatusHistory } from '../validation/validator.js';
import { validateExecPlanControls } from '../session/exec-plan-controls.js';
import { manifestSnapshotFromRecord, verifyProjectAuthoritySnapshot } from '../experiments/manifest.js';

const JOURNAL = '.tmp/project-transaction.json';
const RECOVERY_LOCK = '.tmp/project-recovery.lock';
function fail(message, code = 'VALIDATION') { throw new ResearchOSError(code, message); }
async function contents(root, path) {
  try { return await readUtf8(safeJoin(root, path)); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
function meaningful(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n\u2028\u2029]/u.test(value)) fail(`${name} must be meaningful single-line text`);
}
function strings(value, name, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(`${name} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  for (const item of value) meaningful(item, name);
}
function exact(value, keys, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) fail(`${label} contains unsupported fields`);
}
function validRecord(attributes, path) {
  const schema = schemaForRecordType(attributes.type);
  const issues = schema ? [...validateRecord(schema, attributes), ...validateStatusHistory(attributes, path)] : [{ message: 'Unknown record type' }];
  if (issues.length) throw new ResearchOSError('VALIDATION', `Invalid authority at ${path}`, issues);
}
function liveProcess(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Readers refuse partially published authority until explicit recovery. */
export async function assertProjectTransactionClear(root) {
  if (await contents(root, JOURNAL) !== null) fail('An unfinished project update requires project recover before reading or writing authority.', 'PROJECT_TRANSACTION_PENDING');
}

function validateChanges(root, changes) {
  if (!Array.isArray(changes) || !changes.length) fail('Project changes must be nonempty');
  const paths = new Set();
  for (const change of changes) {
    exact(change, ['path', 'before', 'after'], 'Project change');
    meaningful(change.path, 'change.path');
    safeJoin(root, change.path);
    if (posix.normalize(change.path) !== change.path || change.path.includes('\\') || change.path === '.' || change.path === '.tmp' || change.path.startsWith('.tmp/') || paths.has(change.path)) fail(`Invalid or duplicate transaction path: ${change.path}`);
    if (change.before !== null && typeof change.before !== 'string') fail('change.before must be original text or null for a new file');
    if (typeof change.after !== 'string') fail('change.after must be text');
    paths.add(change.path);
  }
}

async function verifySnapshots(root, inputs) {
  for (const input of inputs) {
    if (Object.hasOwn(input, 'sha256')) {
      if (!/^[a-f0-9]{64}$/u.test(input.sha256)) fail('Expected sha256 must be a hex digest');
      let digest = null;
      try { digest = createHash('sha256').update(await readFile(safeJoin(root, input.path))).digest('hex'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (digest !== input.sha256) fail(`Project input changed: ${input.path}`, 'CONFLICT');
    } else if (await contents(root, input.path) !== input.before) fail(`Project input changed: ${input.path}`, 'CONFLICT');
  }
}
async function actionPaths(root) {
  try { return (await readdir(safeJoin(root, 'plans/actions'))).filter(path => path.endsWith('.md')).map(path => `plans/actions/${path}`).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function restore(root, changes) {
  // Never overwrite a third party edit made after interruption.
  for (const change of changes) {
    const current = await contents(root, change.path);
    if (current !== change.before && current !== change.after) fail(`Cannot restore externally changed file: ${change.path}`, 'CONFLICT');
  }
  for (const change of [...changes].reverse()) {
    if (await contents(root, change.path) === change.before) continue;
    if (change.before === null) await unlink(safeJoin(root, change.path));
    else await writeUtf8Atomic(safeJoin(root, change.path), change.before);
  }
}

/** Small project-local atomic publication with exact input guards and rollback.
 * expectedInputs accepts {path,before} for text or {path,sha256} for binary files.
 * Callers validate their complete proposed records before invoking this helper.
 */
export async function publishProjectChanges(root, inputChanges, options = {}) {
  const changes = safeDataClone(inputChanges, 'changes');
  const { kind = 'project-update', expectedInputs = [], expectedActionPaths } = safeDataClone(options, 'options');
  validateChanges(root, changes);
  await mkdir(safeJoin(root, '.tmp'), { recursive: true });
  if (await contents(root, RECOVERY_LOCK) !== null) fail('Project recovery is running.', 'CONFLICT');
  let journal;
  try { journal = await open(safeJoin(root, JOURNAL), 'wx'); }
  catch (error) { if (error.code === 'EEXIST') fail('Another project update is pending.', 'PROJECT_TRANSACTION_PENDING'); throw error; }
  let staged = false;
  try {
    await journal.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, kind, changes })}\n`);
    await journal.sync();
    await journal.close();
    journal = null;
    await verifySnapshots(root, [...expectedInputs, ...changes]);
    if (expectedActionPaths && JSON.stringify(await actionPaths(root)) !== JSON.stringify([...expectedActionPaths].sort())) fail('Project Action inventory changed.', 'CONFLICT');
    staged = true;
    for (const change of changes) {
      const path = safeJoin(root, change.path);
      await mkdir(dirname(path), { recursive: true });
      await writeUtf8Atomic(path, change.after);
    }
    await unlink(safeJoin(root, JOURNAL));
    return { written: changes.map(change => change.path) };
  } catch (error) {
    if (journal) await journal.close();
    try {
      if (staged) await restore(root, changes);
      await unlink(safeJoin(root, JOURNAL));
    } catch (rollbackError) {
      throw new ResearchOSError('PROJECT_TRANSACTION_PENDING', `Project update failed and requires recovery: ${rollbackError.message}`, { cause: error.message });
    }
    throw error;
  }
}

/** Roll back an interrupted publication; live writers and external edits are protected. */
export async function recoverProjectTransaction(root) {
  await mkdir(safeJoin(root, '.tmp'), { recursive: true });
  let lock;
  try { lock = await open(safeJoin(root, RECOVERY_LOCK), 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousOwner = Number(await contents(root, RECOVERY_LOCK));
    if (!Number.isInteger(previousOwner) || previousOwner <= 0 || liveProcess(previousOwner)) fail('Project recovery is running or its lock needs inspection.', 'CONFLICT');
    await unlink(safeJoin(root, RECOVERY_LOCK));
    try { lock = await open(safeJoin(root, RECOVERY_LOCK), 'wx'); }
    catch (retryError) { if (retryError.code === 'EEXIST') fail('Project recovery is already running.', 'CONFLICT'); throw retryError; }
  }
  try {
    await lock.writeFile(String(process.pid));
    await lock.sync();
    const text = await contents(root, JOURNAL);
    if (text === null) return { recovered: false };
    let journal;
    try { journal = JSON.parse(text); } catch { fail('Project transaction journal is damaged; preserve it for manual inspection.', 'CONFLICT'); }
    if (journal.version !== 1 || !Number.isInteger(journal.pid) || journal.pid <= 0) fail('Project transaction journal is invalid.', 'CONFLICT');
    if (liveProcess(journal.pid)) fail('Project update is still owned by a live process.', 'CONFLICT');
    validateChanges(root, journal.changes);
    await restore(root, journal.changes);
    await unlink(safeJoin(root, JOURNAL));
    return { recovered: true, kind: journal.kind, restored: journal.changes.map(change => change.path) };
  } finally {
    await lock.close();
    await unlink(safeJoin(root, RECOVERY_LOCK));
  }
}

/** Publish a researcher-approved change of direction and complete task dispositions. */
export async function rebaselineProject(root, input) {
  const change = safeDataClone(input, 'rebaseline');
  exact(change, ['approvedBy', 'reason', 'foregroundObjective', 'driver', 'plan', 'actions'], 'rebaseline');
  for (const key of ['approvedBy', 'reason', 'foregroundObjective']) meaningful(change[key], key);
  exact(change.driver, ['id', 'question', 'closureConditions'], 'driver');
  meaningful(change.driver.question, 'driver.question');
  strings(change.driver.closureConditions, 'driver.closureConditions', true);
  exact(change.plan, ['completionConditions', 'scope', 'outOfScope', 'resumePoint'], 'plan');
  strings(change.plan.completionConditions, 'plan.completionConditions', true);
  strings(change.plan.scope, 'plan.scope', true);
  strings(change.plan.outOfScope, 'plan.outOfScope');
  if (!Array.isArray(change.actions)) fail('actions must contain every unfinished Action disposition');
  await assertProjectTransactionClear(root);
  const candidates = await discoverRecordCandidates(root);
  const documents = new Map();
  const byId = new Map();
  for (const candidate of candidates) {
    if (candidate.error) fail(`Cannot rebaseline invalid authority: ${candidate.path}`);
    if (!candidate.document?.attributes.type) continue;
    const before = await readUtf8(safeJoin(root, candidate.path));
    const document = parseMarkdownDocument(before, candidate.path);
    validRecord(document.attributes, candidate.path);
    if (byId.has(document.attributes.id)) fail(`Duplicate record ID: ${document.attributes.id}`);
    const entry = { ...document, before, path: candidate.path };
    documents.set(candidate.path, entry);
    byId.set(document.attributes.id, entry);
  }
  const project = documents.get('PROJECT.md');
  const plan = documents.get(project?.attributes.active_plan);
  const driver = byId.get(change.driver.id);
  if (!project || !plan || driver?.attributes.type !== 'driver') fail('Project, active plan and selected Driver must exist');
  if (isTerminalActionStatus(driver.attributes.status)) fail('Rebaseline requires an active Driver');
  const actions = [...documents.values()].filter(item => item.attributes.type === 'action');
  const undecided = actions.filter(item => !isTerminalActionStatus(item.attributes.status));
  const decisions = new Map();
  for (const decision of change.actions) {
    exact(decision, ['id', 'disposition', 'replacement'], 'action disposition');
    if (!['keep', 'defer', 'cancel', 'supersede'].includes(decision.disposition) || decisions.has(decision.id)) fail(`Invalid or repeated Action disposition: ${decision.id}`);
    if (!undecided.some(item => item.attributes.id === decision.id)) fail(`Disposition must name an unfinished Action: ${decision.id}`);
    if (decision.disposition !== 'supersede' && decision.replacement !== undefined) fail('Only supersede may specify replacement');
    decisions.set(decision.id, decision);
  }
  if (decisions.size !== undecided.length) fail('Every unfinished Action needs an explicit keep, defer, cancel or supersede decision');
  for (const decision of decisions.values()) {
    if (decision.disposition !== 'supersede') continue;
    const replacement = byId.get(decision.replacement);
    if (replacement?.attributes.type !== 'action' || replacement.attributes.id === decision.id || decisions.get(decision.replacement)?.disposition !== 'keep' || !isScheduledActionStatus(replacement.attributes.status)) fail(`Superseded Action ${decision.id} needs a retained, scheduled replacement`);
  }
  const retiring = new Set([...decisions.values()].filter(item => item.disposition !== 'keep').map(item => item.id));
  if (plan.attributes.background_register.some(item => retiring.has(item.action_id) && ['registered', 'running', 'blocked', 'candidate_ready'].includes(item.status))) fail('Receive or release background work before retiring its Action');
  const now = new Date(Math.max(Date.now(), ...[...documents.values()].map(item => Date.parse(item.attributes.updated) + 1))).toISOString();
  const nextProject = { ...project.attributes, foreground_objective: change.foregroundObjective, modules: [...new Set([...project.attributes.modules, 'decisions'])].sort(), updated: now };
  const nextPlan = { ...plan.attributes, completion_conditions: change.plan.completionConditions, scope: change.plan.scope, out_of_scope: change.plan.outOfScope, resume_point: change.plan.resumePoint, updated: now };
  const nextDriver = { ...driver.attributes, question: change.driver.question, closure_conditions: change.driver.closureConditions, updated: now };
  const controlIssues = validateExecPlanControls(nextPlan, plan.path, nextProject);
  if (controlIssues.length) throw new ResearchOSError('VALIDATION', 'Updated plan controls are invalid', controlIssues);
  const { renderPlanBody } = await import('../session/controller.js');
  const changes = [];
  function update(entry, attributes, body = entry.body) {
    validRecord(attributes, entry.path);
    changes.push({ path: entry.path, before: entry.before, after: serializeMarkdownDocument(attributes, body) });
  }
  const nextProjectBody = project.body.replace(/(## Next decision\n)[\s\S]*?(?=\n## |$)/u, (_, heading) => `${heading}\n${change.plan.resumePoint.next_action}\n`);
  update(project, nextProject, nextProjectBody);
  update(driver, nextDriver);
  update(plan, nextPlan, renderPlanBody(nextPlan));
  const actionSummary = [];
  for (const action of undecided) {
    const decision = decisions.get(action.attributes.id);
    const status = { defer: 'deferred', cancel: 'cancelled', supersede: 'superseded' }[decision.disposition] ?? action.attributes.status;
    actionSummary.push({ id: action.attributes.id, disposition: decision.disposition, before: action.attributes.status, after: status, ...(decision.replacement ? { replacement: decision.replacement } : {}) });
    if (status === action.attributes.status) continue;
    const reason = `${change.reason} Approved by ${change.approvedBy}.${decision.replacement ? ` Replaced by ${decision.replacement}.` : ''}`;
    update(action, { ...action.attributes, status, updated: now, status_history: [...action.attributes.status_history, { from: action.attributes.status, to: status, at: now, reason }] });
  }
  const decisionNumber = Math.max(0, ...[...byId.keys()].filter(id => /^DEC-\d+$/u.test(id)).map(id => Number(id.slice(4)))) + 1;
  const decisionId = `DEC-${String(decisionNumber).padStart(3, '0')}`;
  const decisionPath = `decisions/${decisionId}.md`;
  const effects = [...documents.values()].filter(item => item.attributes.type === 'manifest').map(item => {
    try { verifyProjectAuthoritySnapshot(manifestSnapshotFromRecord(item.attributes), nextProject); return { id: item.attributes.id, authorityMatches: true }; }
    catch (error) { return { id: item.attributes.id, authorityMatches: false, reason: error.message }; }
  });
  const summary = {
    before: { foregroundObjective: project.attributes.foreground_objective, driver: { id: driver.attributes.id, question: driver.attributes.question, closureConditions: driver.attributes.closure_conditions }, plan: { completionConditions: plan.attributes.completion_conditions, scope: plan.attributes.scope, outOfScope: plan.attributes.out_of_scope, resumePoint: plan.attributes.resume_point } },
    after: { foregroundObjective: change.foregroundObjective, driver: change.driver, plan: change.plan },
    actions: actionSummary, manifestEffects: effects
  };
  const decisionAttributes = { schema_version: 1, type: 'decision', id: decisionId, status: 'inbox', created: now, updated: now, status_history: [], question: 'Which project direction and task dispositions are approved?', options: [project.attributes.foreground_objective, change.foregroundObjective], selected_option: change.foregroundObjective, rationale: change.reason, impact: [project.attributes.id, driver.attributes.id, plan.attributes.id, ...undecided.map(item => item.attributes.id)], approver: change.approvedBy, decision_date: now, reopen_conditions: [] };
  validRecord(decisionAttributes, decisionPath);
  changes.push({ path: decisionPath, before: null, after: serializeMarkdownDocument(decisionAttributes, `# ${decisionId} — Approved project rebaseline\n\nApproval supplied by: ${change.approvedBy}\n\nReason: ${change.reason}\n\n## Before and after\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\nHistorical experiment, manifest and evidence bytes were preserved. Manifest authority matches are reported above; existing official receipts that bind PROJECT.md must be rechecked against its new bytes.\n`) });
  await publishProjectChanges(root, changes, { kind: 'rebaseline', expectedInputs: [...documents.values()].map(item => ({ path: item.path, before: item.before })), expectedActionPaths: actions.map(item => item.path) });
  return { decisionId, decisionPath, foregroundObjective: change.foregroundObjective, actions: actionSummary, manifestEffects: effects, officialReceiptsRequireRecheck: true, written: changes.map(item => item.path) };
}
