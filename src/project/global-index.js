import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTemplate } from '../core/render.js';
import { ResearchOSError } from '../lib/errors.js';
import { readUtf8, writeUtf8Atomic } from '../lib/fs.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../lib/markdown.js';

const CORE_ROOT = fileURLToPath(new URL('../../core/', import.meta.url));
const TEMPLATE_PATH = join(CORE_ROOT, 'templates/global/PROJECTS.md');
const VERSION_PATH = join(CORE_ROOT, 'VERSION');
export const GLOBAL_COLUMNS = Object.freeze([
  { field: 'project_id', label: 'Project ID' },
  { field: 'title', label: 'Title' },
  { field: 'stage', label: 'Stage' },
  { field: 'status', label: 'Status' },
  { field: 'next_milestone', label: 'Next milestone' },
  { field: 'project_uri', label: 'Vault entry' },
  { field: 'updated', label: 'Updated' }
]);
export const GLOBAL_FIELDS = Object.freeze(GLOBAL_COLUMNS.map(column => column.field));
const GLOBAL_FIELD_SET = new Set(GLOBAL_FIELDS);

function fieldError(message) {
  throw new ResearchOSError('GLOBAL_INDEX_FIELD', message);
}

export function assertGlobalProjectSummary(summary) {
  if (!summary || Array.isArray(summary) || typeof summary !== 'object') fieldError('Global project summary must be an object');
  const keys = Object.keys(summary);
  const extra = keys.filter(key => !GLOBAL_FIELD_SET.has(key));
  const missing = GLOBAL_FIELDS.filter(key => !Object.hasOwn(summary, key));
  if (extra.length > 0) fieldError(`Unsupported global index fields: ${extra.sort().join(',')}`);
  if (missing.length > 0) fieldError(`Missing global index fields: ${missing.join(',')}`);
  for (const field of GLOBAL_FIELDS) {
    if (typeof summary[field] !== 'string' || summary[field].length === 0 || /\0/u.test(summary[field])) {
      fieldError(`Global index field must be a non-empty string: ${field}`);
    }
  }
}

function escapeTableCell(value) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n|\u2028|\u2029/g, '<br>');
}

export function renderGlobalIndexBody(projects) {
  const header = `# Research OS projects\n\n| ${GLOBAL_COLUMNS.map(column => column.label).join(' | ')} |\n| ${GLOBAL_COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = projects.map(project => `| ${GLOBAL_FIELDS.map(field => escapeTableCell(project[field])).join(' | ')} |`);
  return `${header}${rows.length === 0 ? '' : `\n${rows.join('\n')}`}\n`;
}

async function initialIndex() {
  const [template, version] = await Promise.all([readUtf8(TEMPLATE_PATH), readUtf8(VERSION_PATH)]);
  const now = new Date().toISOString();
  return parseMarkdownDocument(renderTemplate(template, { CORE_VERSION: version.trim(), DATE: now }), TEMPLATE_PATH);
}

function parseIndex(text, indexPath) {
  const document = parseMarkdownDocument(text, indexPath);
  if (document.attributes.type !== 'project_index' || !Array.isArray(document.attributes.projects)) {
    throw new ResearchOSError('GLOBAL_INDEX_FIELD', `Invalid global index: ${indexPath}`);
  }
  for (const summary of document.attributes.projects) assertGlobalProjectSummary(summary);
  return document;
}

async function readIndex(indexPath, createIfMissing) {
  try {
    return parseIndex(await readUtf8(indexPath), indexPath);
  } catch (error) {
    if (error.code === 'ENOENT' && createIfMissing) return initialIndex();
    throw error;
  }
}

export async function loadGlobalIndex(indexPath) {
  return (await readIndex(indexPath, false)).attributes;
}

async function saveGlobalIndex(indexPath, projects) {
  const version = (await readUtf8(VERSION_PATH)).trim();
  const sorted = [...projects].sort((left, right) => left.project_id.localeCompare(right.project_id, 'en'));
  const updated = [...sorted].map(project => project.updated).sort().at(-1) ?? new Date().toISOString();
  await mkdir(dirname(indexPath), { recursive: true });
  await writeUtf8Atomic(indexPath, serializeMarkdownDocument({ type: 'project_index', core_version: version, updated, projects: sorted }, renderGlobalIndexBody(sorted)));
}

export async function upsertGlobalProject(indexPath, summary) {
  assertGlobalProjectSummary(summary);
  const index = await readIndex(indexPath, true);
  const projects = [...index.attributes.projects.filter(project => project.project_id !== summary.project_id), summary];
  await saveGlobalIndex(indexPath, projects);
  return summary;
}

export async function listGlobalProjects(indexPath) {
  return [...(await loadGlobalIndex(indexPath)).projects].sort((left, right) => left.project_id.localeCompare(right.project_id, 'en'));
}
