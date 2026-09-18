import { readdir } from 'node:fs/promises';
import { join, posix, relative, resolve } from 'node:path';
import { readUtf8, safeJoin } from '../lib/fs.js';
import { parseMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze, ReadonlyMap } from '../lib/readonly.js';
import { isProjectInternalDirectory } from '../lib/project-tree.js';

const REVIEWER_CANDIDATE = /^(?:reviews\/concerns|writing\/(?:response|changes))\/.+\.md$/u;
const CANDIDATE_SIDECARS = new WeakMap();
const EMPTY_CANDIDATES = Object.freeze([]);

/**
 * @typedef {Object} RecordRef
 * @property {string} id
 * @property {string} type
 * @property {string} path
 * @property {Readonly<Record<string, unknown>>} attributes
 */

function projectRelative(root, path) {
  return relative(root, path).split(/[/\\]/u).join('/');
}

async function candidatePaths(projectRoot) {
  const root = resolve(projectRoot);
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && isProjectInternalDirectory(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) paths.push(projectRelative(root, fullPath));
    }
  }
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * Discover all frontmatter-bearing Markdown candidates, including parse failures.
 * @internal
 * @param {string} projectRoot
 * @returns {Promise<ReadonlyArray<Readonly<{path: string, document?: object, error?: Error}>>>}
 */
export async function discoverRecordCandidates(projectRoot) {
  const { assertProjectTransactionClear } = await import('../project/rebaseline.js');
  await assertProjectTransactionClear(projectRoot);
  const candidates = [];
  for (const path of await candidatePaths(projectRoot)) {
    const text = await readUtf8(safeJoin(projectRoot, posix.normalize(path)));
    if (!text.startsWith('---\n')) {
      if (REVIEWER_CANDIDATE.test(path)) candidates.push(Object.freeze({ path, error: new Error('Reviewer-facing candidate is missing YAML frontmatter') }));
      continue;
    }
    try {
      const document = parseMarkdownDocument(text, path);
      deepFreeze(document.attributes);
      candidates.push(Object.freeze({ path, document }));
    } catch (error) {
      candidates.push(Object.freeze({ path, error }));
    }
  }
  await assertProjectTransactionClear(projectRoot);
  return Object.freeze(candidates);
}

function recordsFromCandidates(candidates) {
  const entries = [];
  for (const candidate of candidates) {
    if (!candidate.document) continue;
    const { attributes } = candidate.document;
    if (typeof attributes.type !== 'string' || typeof attributes.id !== 'string') continue;
    const record = Object.freeze({ id: attributes.id, type: attributes.type, path: candidate.path, attributes });
    entries.push([candidate.path, record]);
  }
  return new ReadonlyMap(entries);
}

/**
 * Discover valid-identity canonical records keyed by project-relative path.
 * @param {string} projectRoot
 * @returns {Promise<ReadonlyMap<string, RecordRef>>}
 */
export async function discoverRecords(projectRoot) {
  return recordsFromCandidates(await discoverRecordCandidates(projectRoot));
}

/**
 * Discover a genuine read-only catalog with an unforgeable, frozen sidecar for
 * reviewer-facing candidates. The scan is performed once to avoid TOCTOU gaps.
 * @param {string} projectRoot
 * @returns {Promise<ReadonlyMap<string, RecordRef>>}
 */
export async function discoverWritingCatalog(projectRoot) {
  const candidates = await discoverRecordCandidates(projectRoot);
  const records = recordsFromCandidates(candidates);
  const snapshots = candidates
    .filter(candidate => REVIEWER_CANDIDATE.test(candidate.path))
    .map(candidate => candidate.document
      ? Object.freeze({ path: candidate.path, attributes: candidate.document.attributes })
      : Object.freeze({ path: candidate.path, parseError: true }));
  const frozen = deepFreeze(snapshots);
  CANDIDATE_SIDECARS.set(records, frozen);
  return records;
}

/** @internal Return the immutable reviewer-candidate sidecar for a genuine catalog. */
export function writingCandidateSnapshots(catalog) {
  return CANDIDATE_SIDECARS.get(catalog) ?? EMPTY_CANDIDATES;
}
