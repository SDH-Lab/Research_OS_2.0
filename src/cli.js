import { checkpointRepositoryStatus } from './session/repository-status.js';
import { configureAction, recordActionCheck, recordActionBlocker, approveActionScope } from './actions/workflow.js';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, ResearchOSError } from './lib/errors.js';
import { ReadonlyMap, ReadonlySet } from './lib/readonly.js';
import { addProjectResource, enableModule, initProject, listProjectResources, loadProject } from './project/project.js';
import { inspectProjectSetup } from './project/setup-status.js';
import { listGlobalProjects, upsertGlobalProject } from './project/global-index.js';
import { assertResourceName, resolveResourceRef } from './project/resources.js';
import { createRecord, updateRecordStatus } from './records/create.js';
import { discoverRecords, discoverWritingCatalog } from './records/catalog.js';
import { traceClaim } from './records/trace.js';
import { checkpointDisruption, checkpointSession, getSessionContext, preflightSession, registerBackgroundWork } from './session/controller.js';
import { checkWriteScope } from './session/write-scope.js';
import { validateProject } from './validation/validator.js';
import { normalizeManifest } from './experiments/manifest.js';
import { compareContract } from './experiments/contract.js';
import { authorizeOfficialRun } from './experiments/official-gate.js';
import { computeConcernCoverage, validateResponseBlock, validateReviewerFacingCatalog } from './writing/response.js';
import { validateDelivery } from './writing/delivery.js';
import { buildViews, calculateForecastForProject, cleanViews, showView } from './views/generate.js';
import { applyCoreUpgrade, previewCoreUpgrade } from './core/upgrade.js';
import { runDoctor } from './doctor.js';
import { installResearchOsSkill, verifyResearchOsSkill } from './skill/installation.js';
import { locateGuide } from './guide.js';

const TOP_LEVEL_COMMANDS = new Map();
function commandSpec(allowed, required = allowed) {
  return Object.freeze({ allowed: Object.freeze([...allowed]), required: Object.freeze([...required]) });
}

export const COMMAND_SPECS = new Map([
  ['project init', commandSpec(['--target', '--id', '--title', '--stage', '--core'], ['--target', '--id', '--title', '--stage'])],
  ['project show', commandSpec(['--project'])],
  ['project setup-status', commandSpec(['--project'])],
  ['project rebaseline', commandSpec(['--project', '--change'])],
  ['project recover', commandSpec(['--project'])],
  ['action configure', commandSpec(['--project', '--id', '--definition'])],
  ['action check', commandSpec(['--project', '--id', '--check'])],
  ['action blocker', commandSpec(['--project', '--id', '--change'])],
  ['action approve', commandSpec(['--project', '--id', '--approval'])],
  ['action claim', commandSpec(['--project', '--id', '--observation'], ['--project', '--id'])],
  ['action ready', commandSpec(['--project'])],
  ['artifact accept', commandSpec(['--project', '--id', '--acceptance'])],
  ['project resource add', commandSpec(['--project', '--name', '--uri', '--role', '--access', '--identity'], ['--project', '--name', '--uri', '--role', '--access'])],
  ['project resource list', commandSpec(['--project'])],
  ['project resource resolve', commandSpec(['--project', '--ref'])],
  ['project index add', commandSpec(['--index', '--project', '--next-milestone', '--project-uri'], ['--index', '--project', '--next-milestone'])],
  ['project index list', commandSpec(['--index'])],
  ['module enable', commandSpec(['--project', '--name'])],
  ['record new', commandSpec(['--project', '--type', '--id', '--title', '--values'], ['--project', '--type', '--id', '--title'])],
  ['record status', commandSpec(['--project', '--id', '--to', '--reason', '--affected-ids', '--verified-at', '--accepted-by'], ['--project', '--id', '--to'])],
  ['record validate', commandSpec(['--project'])],
  ['record trace', commandSpec(['--project', '--id'])],
  ['session context', commandSpec(['--project'])],
  ['session preflight', commandSpec(['--project', '--claim'])],
  ['session background', commandSpec(['--project', '--registration'])],
  ['session checkpoint', commandSpec(['--project', '--update'])],
  ['session check-diff', commandSpec(['--registration', '--changed-paths'])],
  ['session disruption', commandSpec(['--project', '--update'])],
  ['experiment manifest-check', commandSpec(['--project', '--manifest'])],
  ['experiment contract-diff', commandSpec(['--project', '--contract', '--manifest'])],
  ['experiment authorize', commandSpec(['--project', '--diff', '--mechanical-smoke', '--semantic-smoke', '--waivers'])],
  ['writing coverage', commandSpec(['--project'])],
  ['writing validate-block', commandSpec(['--project', '--id'])],
  ['writing delivery-check', commandSpec(['--project', '--rendered-artifacts'])],
  ['view build', commandSpec(['--project'])],
  ['view clean', commandSpec(['--project'])],
  ['view show', commandSpec(['--project', '--name'])],
  ['forecast calculate', commandSpec(['--project'])],
  ['core upgrade-preview', commandSpec(['--project', '--candidate-core'])],
  ['core upgrade-apply', commandSpec(['--project', '--candidate-core', '--preview-hash'])],
  ['skill install', commandSpec(['--target'])],
  ['skill verify', commandSpec(['--target'])],
  ['guide locate', commandSpec([])],
  ['doctor', commandSpec(['--project'])]
]);
export const COMMANDS = COMMAND_SPECS;
const DEFAULT_CORE_ROOT = fileURLToPath(new URL('../core/', import.meta.url));

const HELP = `Research OS\n\nCommands:\n  action\n  artifact\n  project\n  module\n  record\n  session\n  experiment\n  writing\n  view\n  forecast\n  core\n  skill\n  guide\n  doctor\n`;

function usage(message) {
  throw new ResearchOSError('USAGE', message);
}

export function parseOptions(args, { allowed, required }) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.includes(option) || value === undefined || value.startsWith('--') || Object.hasOwn(options, option)) {
      usage(`Invalid option: ${option ?? ''}`.trim());
    }
    options[option] = value;
  }
  for (const option of required) {
    if (!Object.hasOwn(options, option)) usage(`Missing required option: ${option}`);
  }
  return options;
}

function normalizeJson(value) {
  if (value instanceof Set || value instanceof ReadonlySet) return [...value].map(normalizeJson).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  if (value instanceof Map || value instanceof ReadonlyMap) {
    return Object.fromEntries([...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right), 'en')).map(([key, item]) => [key, normalizeJson(item)]));
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]));
  return value;
}

function writeJson(io, value) {
  io.stdout(`${JSON.stringify(normalizeJson(value))}\n`);
}

function parseJsonOption(value, option, expected) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    usage(`${option} must be valid JSON`);
  }
  if (expected === 'object' && (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')) usage(`${option} must be a JSON object`);
  if (expected === 'array' && !Array.isArray(parsed)) usage(`${option} must be a JSON array`);
  return parsed;
}

function assertCliSingleLine(value, option) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\u2028\u2029\0]/u.test(value)) usage(`${option} must be a non-empty single-line string`);
}

async function projectResourceCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'add') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project resource add'));
    for (const option of ['--name', '--uri', '--role', '--access']) assertCliSingleLine(options[option], option);
    if (options['--identity'] !== undefined) assertCliSingleLine(options['--identity'], '--identity');
    try {
      assertResourceName(options['--name']);
    } catch {
      usage(`Invalid resource name: ${options['--name']}`);
    }
    if (!['read-only', 'read-write'].includes(options['--access'])) usage(`Invalid resource access: ${options['--access']}`);
    const resource = {
      uri: options['--uri'], role: options['--role'], access: options['--access'],
      ...(options['--identity'] === undefined ? {} : { identity: options['--identity'] })
    };
    writeJson(io, await addProjectResource(options['--project'], options['--name'], resource));
    return EXIT_CODES.OK;
  }
  if (action === 'list') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project resource list'));
    writeJson(io, await listProjectResources(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'resolve') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project resource resolve'));
    writeJson(io, resolveResourceRef(await loadProject(options['--project']), options['--ref']));
    return EXIT_CODES.OK;
  }
  usage(`Unknown project resource command: ${action ?? ''}`.trim());
}

async function projectIndexCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'add') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project index add'));
    assertCliSingleLine(options['--next-milestone'], '--next-milestone');
    if (options['--project-uri'] !== undefined) assertCliSingleLine(options['--project-uri'], '--project-uri');
    const project = await loadProject(options['--project']);
    writeJson(io, await upsertGlobalProject(options['--index'], {
      project_id: project.project_id,
      title: project.title,
      stage: project.stage,
      status: project.status,
      next_milestone: options['--next-milestone'],
      project_uri: options['--project-uri'] ?? options['--project'],
      updated: project.updated
    }));
    return EXIT_CODES.OK;
  }
  if (action === 'list') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project index list'));
    writeJson(io, await listGlobalProjects(options['--index']));
    return EXIT_CODES.OK;
  }
  usage(`Unknown project index command: ${action ?? ''}`.trim());
}

async function projectCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'init') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project init'));
    const result = await initProject({
      targetDir: options['--target'],
      projectId: options['--id'],
      title: options['--title'],
      stage: options['--stage'],
      coreRoot: options['--core'] ?? DEFAULT_CORE_ROOT
    });
    writeJson(io, result);
    return EXIT_CODES.OK;
  }
  if (action === 'show') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project show'));
    writeJson(io, await loadProject(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'setup-status') {
    const options = parseOptions(rest, COMMAND_SPECS.get('project setup-status'));
    writeJson(io, await inspectProjectSetup(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'rebaseline' || action === 'recover') {
    const options = parseOptions(rest, COMMAND_SPECS.get(`project ${action}`));
    const { rebaselineProject, recoverProjectTransaction } = await import('./project/rebaseline.js');
    writeJson(io, action === 'recover' ? await recoverProjectTransaction(options['--project'])
      : await rebaselineProject(options['--project'], parseJsonOption(options['--change'], '--change', 'object')));
    return EXIT_CODES.OK;
  }
  if (action === 'resource') return projectResourceCommand(rest, io);
  if (action === 'index') return projectIndexCommand(rest, io);
  usage(`Unknown project command: ${action ?? ''}`.trim());
}

async function moduleCommand(args, io) {
  const [action, ...rest] = args;
  if (action !== 'enable') usage(`Unknown module command: ${action ?? ''}`.trim());
  const options = parseOptions(rest, COMMAND_SPECS.get('module enable'));
  writeJson(io, await enableModule(options['--project'], options['--name']));
  return EXIT_CODES.OK;
}

async function recordCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'new') {
    const options = parseOptions(rest, COMMAND_SPECS.get('record new'));
    const values = options['--values'] === undefined ? {} : parseJsonOption(options['--values'], '--values', 'object');
    const identityFields = ['id', 'title'].filter(field => Object.hasOwn(values, field));
    if (identityFields.length > 0) usage(`--values cannot include identity field(s): ${identityFields.join(', ')}`);
    writeJson(io, await createRecord(options['--project'], options['--type'], { ...values, id: options['--id'], title: options['--title'] }));
    return EXIT_CODES.OK;
  }
  if (action === 'status') {
    const options = parseOptions(rest, COMMAND_SPECS.get('record status'));
    const affectedIds = options['--affected-ids'] === undefined ? undefined : parseJsonOption(options['--affected-ids'], '--affected-ids', 'array');
    if (affectedIds?.some(id => typeof id !== 'string')) usage('--affected-ids must contain only strings');
    writeJson(io, await updateRecordStatus(options['--project'], options['--id'], options['--to'], {
      reason: options['--reason'], affectedIds, verifiedAt: options['--verified-at'], acceptedBy: options['--accepted-by']
    }));
    return EXIT_CODES.OK;
  }
  if (action === 'validate') {
    const options = parseOptions(rest, COMMAND_SPECS.get('record validate'));
    const report = await validateProject(options['--project']);
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (action === 'trace') {
    const options = parseOptions(rest, COMMAND_SPECS.get('record trace'));
    writeJson(io, await traceClaim(options['--project'], options['--id']));
    return EXIT_CODES.OK;
  }
  usage(`Unknown record command: ${action ?? ''}`.trim());
}

async function actionCommand(args, io) {
  const [action, ...rest] = args;
  const spec = COMMAND_SPECS.get(`action ${action}`);
  if (!spec) usage(`Unknown action command: ${action}`);
  const options = parseOptions(rest, spec);
  if (action === 'ready' || action === 'claim') {
    const { deriveExecutionReadiness, claimExecution } = await import('./session/execution.js');
    const report = action === 'ready' ? await deriveExecutionReadiness(options['--project'])
      : await claimExecution(options['--project'], options['--id'], options['--observation'] === undefined ? undefined : parseJsonOption(options['--observation'], '--observation', 'object'));
    writeJson(io, report);
    return report.ok === false ? EXIT_CODES.VALIDATION : EXIT_CODES.OK;
  }
  const handlers = { configure: [configureAction, '--definition'], check: [recordActionCheck, '--check'], blocker: [recordActionBlocker, '--change'], approve: [approveActionScope, '--approval'] };
  const [handler, argument] = handlers[action];
  writeJson(io, await handler(options['--project'], options['--id'], parseJsonOption(options[argument], argument, 'object')));
  return EXIT_CODES.OK;
}

async function artifactCommand(args, io) {
  const [action, ...rest] = args;
  if (action !== 'accept') usage(`Unknown artifact command: ${action}`);
  const options = parseOptions(rest, COMMAND_SPECS.get('artifact accept'));
  const { acceptArtifact } = await import('./session/execution.js');
  writeJson(io, await acceptArtifact(options['--project'], options['--id'], parseJsonOption(options['--acceptance'], '--acceptance', 'object')));
  return EXIT_CODES.OK;
}

async function sessionCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'context') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session context'));
    writeJson(io, await getSessionContext(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'preflight') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session preflight'));
    const claim = parseJsonOption(options['--claim'], '--claim', 'object');
    const report = await preflightSession(options['--project'], claim);
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (action === 'background') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session background'));
    const registration = parseJsonOption(options['--registration'], '--registration', 'object');
    writeJson(io, { id: await registerBackgroundWork(options['--project'], registration) });
    return EXIT_CODES.OK;
  }
  if (action === 'checkpoint') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session checkpoint'));
    const update = parseJsonOption(options['--update'], '--update', 'object');
    const checkpoint = await checkpointSession(options['--project'], update);
    writeJson(io, { ok: true, ...checkpoint, repository: await checkpointRepositoryStatus(options['--project']) });
    return EXIT_CODES.OK;
  }
  if (action === 'check-diff') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session check-diff'));
    const registration = parseJsonOption(options['--registration'], '--registration', 'object');
    const changedPaths = parseJsonOption(options['--changed-paths'], '--changed-paths', 'array');
    const report = checkWriteScope(registration, changedPaths);
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (action === 'disruption') {
    const options = parseOptions(rest, COMMAND_SPECS.get('session disruption'));
    const update = parseJsonOption(options['--update'], '--update', 'object');
    await checkpointDisruption(options['--project'], update);
    writeJson(io, { ok: true });
    return EXIT_CODES.OK;
  }
  usage(`Unknown session command: ${action ?? ''}`.trim());
}

async function experimentCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'manifest-check') {
    const options = parseOptions(rest, COMMAND_SPECS.get('experiment manifest-check'));
    const project = await loadProject(options['--project']);
    writeJson(io, normalizeManifest(parseJsonOption(options['--manifest'], '--manifest', 'object'), { project }));
    return EXIT_CODES.OK;
  }
  if (action === 'contract-diff') {
    const options = parseOptions(rest, COMMAND_SPECS.get('experiment contract-diff'));
    const project = await loadProject(options['--project']);
    writeJson(io, compareContract(
      parseJsonOption(options['--contract'], '--contract', 'object'),
      parseJsonOption(options['--manifest'], '--manifest', 'object'),
      { project }
    ));
    return EXIT_CODES.OK;
  }
  if (action === 'authorize') {
    const options = parseOptions(rest, COMMAND_SPECS.get('experiment authorize'));
    const project = await loadProject(options['--project']);
    writeJson(io, authorizeOfficialRun({
      contractDiff: parseJsonOption(options['--diff'], '--diff', 'object'),
      mechanicalSmoke: options['--mechanical-smoke'],
      semanticSmoke: options['--semantic-smoke'],
      waivers: parseJsonOption(options['--waivers'], '--waivers', 'array')
    }, { project }));
    return EXIT_CODES.OK;
  }
  usage(`Unknown experiment command: ${action ?? ''}`.trim());
}

async function writingCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'coverage') {
    const options = parseOptions(rest, COMMAND_SPECS.get('writing coverage'));
    const report = computeConcernCoverage(await discoverWritingCatalog(options['--project']));
    writeJson(io, report);
    return report.closable ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (action === 'validate-block') {
    const options = parseOptions(rest, COMMAND_SPECS.get('writing validate-block'));
    assertCliSingleLine(options['--id'], '--id');
    const catalog = await discoverWritingCatalog(options['--project']);
    const matches = [...catalog.values()].filter(record => record.attributes.id === options['--id']);
    const globalIssues = validateReviewerFacingCatalog(catalog);
    const mergeIssues = (...groups) => Object.freeze([...new Map(groups.flat().map(item => [JSON.stringify(item), item])).values()]
      .sort((left, right) => left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'en')));
    if (matches.length === 0) {
      const expectedPath = `writing/response/${options['--id']}.md`;
      const selectedIssues = globalIssues.filter(item => item.path === expectedPath);
      if (selectedIssues.length === 0) throw new ResearchOSError('RECORD_NOT_FOUND', `Record not found: ${options['--id']}`);
      const issues = mergeIssues(globalIssues);
      writeJson(io, Object.freeze({ id: options['--id'], ok: false, issues }));
      return EXIT_CODES.VALIDATION;
    }
    if (matches.length > 1) {
      const ambiguity = Object.freeze({
        severity: 'error', code: 'RESPONSE_RECORD_AMBIGUOUS', path: `record:${options['--id']}`,
        message: `Record ID is not unique: ${options['--id']}`, relatedIds: Object.freeze([options['--id']])
      });
      const issues = mergeIssues(globalIssues, [ambiguity]);
      writeJson(io, Object.freeze({ id: options['--id'], ok: false, issues }));
      return EXIT_CODES.VALIDATION;
    }
    const issues = mergeIssues(globalIssues, validateResponseBlock(matches[0], catalog));
    const report = Object.freeze({ id: options['--id'], ok: issues.every(item => item.severity !== 'error'), issues });
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  if (action === 'delivery-check') {
    const options = parseOptions(rest, COMMAND_SPECS.get('writing delivery-check'));
    const renderedArtifacts = parseJsonOption(options['--rendered-artifacts'], '--rendered-artifacts', 'array');
    const catalog = await discoverWritingCatalog(options['--project']);
    const projectMatches = [...catalog.values()].filter(record => record.path === 'PROJECT.md' && record.attributes.type === 'project');
    const canonicalSources = projectMatches.length === 1 ? projectMatches[0].attributes.canonical_writing_sources : null;
    const report = validateDelivery({ catalog, canonicalSources, renderedArtifacts });
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  usage(`Unknown writing command: ${action ?? ''}`.trim());
}

async function viewCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'build') {
    const options = parseOptions(rest, COMMAND_SPECS.get('view build'));
    writeJson(io, await buildViews(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'clean') {
    const options = parseOptions(rest, COMMAND_SPECS.get('view clean'));
    writeJson(io, await cleanViews(options['--project']));
    return EXIT_CODES.OK;
  }
  if (action === 'show') {
    const options = parseOptions(rest, COMMAND_SPECS.get('view show'));
    writeJson(io, await showView(options['--project'], options['--name']));
    return EXIT_CODES.OK;
  }
  usage(`Unknown view command: ${action ?? ''}`.trim());
}

async function forecastCommand(args, io) {
  const [action, ...rest] = args;
  if (action !== 'calculate') usage(`Unknown forecast command: ${action ?? ''}`.trim());
  const options = parseOptions(rest, COMMAND_SPECS.get('forecast calculate'));
  writeJson(io, await calculateForecastForProject(options['--project']));
  return EXIT_CODES.OK;
}

async function coreCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'upgrade-preview') {
    const options = parseOptions(rest, COMMAND_SPECS.get('core upgrade-preview'));
    writeJson(io, await previewCoreUpgrade(options['--project'], options['--candidate-core']));
    return EXIT_CODES.OK;
  }
  if (action === 'upgrade-apply') {
    const options = parseOptions(rest, COMMAND_SPECS.get('core upgrade-apply'));
    writeJson(io, await applyCoreUpgrade(options['--project'], options['--candidate-core'], options['--preview-hash']));
    return EXIT_CODES.OK;
  }
  usage(`Unknown core command: ${action ?? ''}`.trim());
}

async function skillCommand(args, io) {
  const [action, ...rest] = args;
  if (action === 'install') {
    const options = parseOptions(rest, COMMAND_SPECS.get('skill install'));
    writeJson(io, await installResearchOsSkill({ skillsRoot: options['--target'] }));
    return EXIT_CODES.OK;
  }
  if (action === 'verify') {
    const options = parseOptions(rest, COMMAND_SPECS.get('skill verify'));
    const report = await verifyResearchOsSkill({ skillsRoot: options['--target'] });
    writeJson(io, report);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  }
  usage(`Unknown skill command: ${action ?? ''}`.trim());
}

async function guideCommand(args, io) {
  const [action, ...rest] = args;
  if (action !== 'locate') usage(`Unknown guide command: ${action ?? ''}`.trim());
  parseOptions(rest, COMMAND_SPECS.get('guide locate'));
  writeJson(io, await locateGuide());
  return EXIT_CODES.OK;
}

async function doctorCommand(args, io) {
  const options = parseOptions(args, COMMAND_SPECS.get('doctor'));
  const report = await runDoctor(options['--project']);
  writeJson(io, report);
  return report.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
}

TOP_LEVEL_COMMANDS.set('project', projectCommand);
TOP_LEVEL_COMMANDS.set('action', actionCommand);
TOP_LEVEL_COMMANDS.set('artifact', artifactCommand);
TOP_LEVEL_COMMANDS.set('module', moduleCommand);
TOP_LEVEL_COMMANDS.set('record', recordCommand);
TOP_LEVEL_COMMANDS.set('session', sessionCommand);
TOP_LEVEL_COMMANDS.set('experiment', experimentCommand);
TOP_LEVEL_COMMANDS.set('writing', writingCommand);
TOP_LEVEL_COMMANDS.set('view', viewCommand);
TOP_LEVEL_COMMANDS.set('forecast', forecastCommand);
TOP_LEVEL_COMMANDS.set('core', coreCommand);
TOP_LEVEL_COMMANDS.set('skill', skillCommand);
TOP_LEVEL_COMMANDS.set('guide', guideCommand);
TOP_LEVEL_COMMANDS.set('doctor', doctorCommand);

const ERROR_EXIT_CODES = Object.freeze({
  ACTION_WORKFLOW: EXIT_CODES.VALIDATION,
  EXECUTION_BLOCKED: EXIT_CODES.BLOCKED,
  PROJECT_TRANSACTION_PENDING: EXIT_CODES.BLOCKED,
  RECORD_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  INVALID_TRANSITION: EXIT_CODES.VALIDATION,
  STATUS_CONDITION: EXIT_CODES.VALIDATION,
  TRACE_ROOT_TYPE: EXIT_CODES.VALIDATION,
  MISSING_ACTIVE_PLAN: EXIT_CODES.VALIDATION,
  MULTIPLE_ACTIVE_PLANS: EXIT_CODES.VALIDATION,
  RESUME_POINT_MISSING: EXIT_CODES.VALIDATION,
  MANIFEST_INVALID: EXIT_CODES.VALIDATION,
  CONTRACT_INVALID: EXIT_CODES.VALIDATION,
  OFFICIAL_RUN_BLOCKED: EXIT_CODES.BLOCKED,
  CODE_ROOT_NOT_APPROVED: EXIT_CODES.BLOCKED,
  UPGRADE_PREVIEW_MISMATCH: EXIT_CODES.VALIDATION,
  UPGRADE_VALIDATION_FAILED: EXIT_CODES.VALIDATION,
  CORE_VERSION_MISMATCH: EXIT_CODES.VALIDATION,
  CORE_VERSION: EXIT_CODES.VALIDATION,
  CORE_PACKAGE_INVALID: EXIT_CODES.VALIDATION,
  CORE_MIGRATION_REQUIRED: EXIT_CODES.VALIDATION,
  CORE_BACKUP_BYTES_MISMATCH: EXIT_CODES.VALIDATION,
  CORE_BACKUP_RECEIPT_MISMATCH: EXIT_CODES.VALIDATION,
  CORE_CANDIDATE_IO: EXIT_CODES.IO
});

export async function main(argv, io = { stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) }) {
  const [command] = argv;

  if (command === '--help' || command === '-h' || command === undefined) {
    io.stdout(HELP);
    return EXIT_CODES.OK;
  }

  const handler = TOP_LEVEL_COMMANDS.get(command);
  if (!handler) {
    io.stderr(`Unknown command: ${command}\n`);
    return EXIT_CODES.USAGE;
  }

  try {
    return await handler(argv.slice(1), io);
  } catch (error) {
    if (error instanceof ResearchOSError) {
      io.stderr(`[${error.code}] ${error.message}\n`);
      return EXIT_CODES[error.code] ?? ERROR_EXIT_CODES[error.code] ?? EXIT_CODES.IO;
    }
    throw error;
  }
}
