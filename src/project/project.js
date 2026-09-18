import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCore } from '../core/catalog.js';
import { renderTemplate } from '../core/render.js';
import { ResearchOSError } from '../lib/errors.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';
import { readUtf8, safeJoin, writeUtf8Atomic } from '../lib/fs.js';
import { assertResource, assertResourceName, assertResources } from './resources.js';
import { validateRecord } from '../validation/validator.js';

export const MODULES = new Set(['research', 'experiments', 'evidence', 'writing', 'reviews', 'decisions', 'incidents', 'generated', 'archive']);

async function assertEmptyDirectory(targetDir) {
  try {
    if ((await readdir(targetDir)).length > 0) {
      throw new ResearchOSError('CONFLICT', `Target directory is not empty: ${targetDir}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function projectTemplateValues({ projectId, title, stage, resources = {}, clock = () => new Date() }, coreVersion) {
  const instant = clock();
  const date = (instant instanceof Date ? instant : new Date(instant)).toISOString();
  return {
    PROJECT_RECORD_ID: 'PRJ-001',
    PROJECT_ID: projectId,
    TITLE: title,
    STAGE: stage,
    PROJECT_YAML_ID: JSON.stringify(projectId),
    TITLE_YAML: JSON.stringify(title),
    STAGE_YAML: JSON.stringify(stage),
    ACTIVE_PLAN: 'plans/active.md',
    ACTIVE_PLAN_ID: 'PLN-001',
    CORE_VERSION: coreVersion,
    DATE: date,
    RESOURCES: JSON.stringify(resources),
    FORECAST_SETTINGS: JSON.stringify({
      as_of: date.slice(0, 10),
      timezone: 'UTC',
      integration_buffer: 0.2,
      default_weekly_capacity: 5,
      capacity_calendar: []
    }),
    NEXT_DECISION: 'Define the foreground objective.',
    FOREGROUND_OBJECTIVE: 'Not set',
    RESUME_POINT: JSON.stringify({
      last_verified_point: 'Project initialized.',
      next_action: 'Define the foreground objective.',
      next_command_or_edit: null,
      required_files: ['PROJECT.md', 'plans/active.md'],
      risks: [],
      reforecast_trigger: null
    })
  };
}

function assertSingleLineIdentity({ projectId, title, stage }) {
  for (const [name, value] of Object.entries({ projectId, title, stage })) {
    if (typeof value !== 'string' || value.length === 0 || /[\r\n\u2028\u2029]/u.test(value)) {
      throw new ResearchOSError('USAGE', `${name} must be a non-empty single-line string`);
    }
  }
}

function nextUpdated(previousUpdated) {
  const previousTime = Date.parse(previousUpdated);
  const now = Date.now();
  return new Date(Math.max(now, Number.isNaN(previousTime) ? now : previousTime + 1)).toISOString();
}

async function validateGeneratedRecords(projectRoot) {
  const project = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, 'PROJECT.md')), 'PROJECT.md').attributes;
  const activePlan = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, 'plans/active.md')), 'plans/active.md').attributes;
  const issues = [...validateRecord('project', project), ...validateRecord('exec-plan', activePlan)];
  if (issues.length > 0) {
    throw new ResearchOSError('VALIDATION', `Generated records failed validation: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`, issues);
  }
}

export async function initProject(input) {
  assertSingleLineIdentity(input);
  await assertEmptyDirectory(input.targetDir);
  await mkdir(input.targetDir, { recursive: true });
  const core = await loadCore(input.coreRoot);
  const values = projectTemplateValues(input, core.version);
  await writeUtf8Atomic(safeJoin(input.targetDir, 'AGENTS.md'), renderTemplate(core.templates.project.AGENTS, values));
  await writeUtf8Atomic(safeJoin(input.targetDir, 'PROJECT.md'), renderTemplate(core.templates.project.PROJECT, values));
  await mkdir(safeJoin(input.targetDir, 'plans'), { recursive: true });
  await writeUtf8Atomic(safeJoin(input.targetDir, 'plans/active.md'), renderTemplate(core.templates.project['active-plan'], values));
  await mkdir(safeJoin(input.targetDir, '.obsidian'), { recursive: true });
  await writeUtf8Atomic(safeJoin(input.targetDir, '.obsidian/app.json'), '{}\n');
  await validateGeneratedRecords(input.targetDir);
  return {
    projectRoot: input.targetDir,
    created: ['AGENTS.md', 'PROJECT.md', 'plans', '.obsidian'],
    setupRequired: true,
    nextCommand: `research-os project setup-status --project ${input.targetDir}`
  };
}

export async function loadProject(projectRoot) {
  const { assertProjectTransactionClear } = await import('./rebaseline.js');
  await assertProjectTransactionClear(projectRoot);
  return parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, 'PROJECT.md')), 'PROJECT.md').attributes;
}

async function saveProject(projectRoot, project, body) {
  const projectPath = safeJoin(projectRoot, 'PROJECT.md');
  const document = parseMarkdownDocument(await readUtf8(projectPath), 'PROJECT.md');
  await writeUtf8Atomic(projectPath, serializeMarkdownDocument(project, body ?? document.body));
}

function addModuleLink(body, moduleName) {
  const link = `- [${moduleName}](${moduleName}/README.md)\n`;
  if (body.includes(link)) return body;
  const heading = '## Modules\n';
  const sectionStart = body.indexOf(heading);
  if (sectionStart === -1) return `${body.trimEnd()}\n\n${heading}\n${link}`;
  const nextHeading = body.indexOf('\n## ', sectionStart + heading.length);
  const insertionPoint = nextHeading === -1 ? body.length : nextHeading + 1;
  return `${body.slice(0, insertionPoint).trimEnd()}\n${link}${body.slice(insertionPoint)}`;
}

async function createModuleLanding(projectRoot, moduleName) {
  const moduleDirectory = safeJoin(projectRoot, moduleName);
  const readmePath = safeJoin(projectRoot, join(moduleName, 'README.md'));
  await mkdir(moduleDirectory, { recursive: true });
  await writeUtf8Atomic(readmePath, `# ${moduleName}\n\nAuthority: ${moduleName} records.\n\nEntry point: this directory.\n`);
  return [`${moduleName}/README.md`];
}

export async function enableModule(projectRoot, moduleName) {
  if (!MODULES.has(moduleName)) throw new ResearchOSError('USAGE', `Unknown module: ${moduleName}`);
  const project = await loadProject(projectRoot);
  if (project.modules.includes(moduleName)) return { moduleName, createdFiles: [] };
  const createdFiles = await createModuleLanding(projectRoot, moduleName);
  const document = parseMarkdownDocument(await readUtf8(safeJoin(projectRoot, 'PROJECT.md')), 'PROJECT.md');
  await saveProject(projectRoot, { ...project, modules: [...project.modules, moduleName].sort() }, addModuleLink(document.body, moduleName));
  return { moduleName, createdFiles };
}

export async function addProjectResource(projectRoot, name, resource) {
  assertResourceName(name);
  assertResource(resource, name);
  const projectPath = safeJoin(projectRoot, 'PROJECT.md');
  const document = parseMarkdownDocument(await readUtf8(projectPath), 'PROJECT.md');
  const resources = document.attributes.resources;
  assertResources(resources);
  if (Object.hasOwn(resources, name)) throw new ResearchOSError('CONFLICT', `Resource already exists: ${name}`);
  const nextProject = {
    ...document.attributes,
    resources: { ...resources, [name]: resource },
    updated: nextUpdated(document.attributes.updated)
  };
  assertResources(nextProject.resources);
  const issues = validateRecord('project', nextProject);
  if (issues.length > 0) throw new ResearchOSError('VALIDATION', `Project failed validation: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`, issues);
  await writeUtf8Atomic(projectPath, serializeMarkdownDocument(nextProject, document.body));
  return { name, resource };
}

export async function listProjectResources(projectRoot) {
  const project = await loadProject(projectRoot);
  assertResources(project.resources);
  return Object.entries(project.resources)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, resource]) => ({ name, ...resource }));
}
