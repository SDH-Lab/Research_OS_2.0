import { ResearchOSError } from '../lib/errors.js';
import { resolveResourceRef } from '../project/resources.js';
import { deepFreeze, ReadonlySet } from '../lib/readonly.js';
import { discoverRecords } from './catalog.js';

const ID = /^[A-Z]+-[0-9]{3,}$/u;

export const PROVENANCE_LINK_FIELDS = Object.freeze({
  claim: Object.freeze(['evidence']),
  evidence: Object.freeze(['sources', 'counterevidence', 'supported_claims', 'writing_destinations']),
  result: Object.freeze(['run', 'follow_up']),
  run: Object.freeze(['experiment', 'manifest']),
  driver: Object.freeze(['actions']),
  action: Object.freeze(['driver', 'inputs', 'outputs', 'dependencies']),
  artifact: Object.freeze(['producer_action']),
  writing: Object.freeze(['claims', 'concern', 'evidence_or_reason', 'manuscript_changes', 'covered_actions', 'response_blocks']),
  incident: Object.freeze(['evidence']),
  risk: Object.freeze(['evidence']),
  decision: Object.freeze(['impact']),
  experiment: Object.freeze([]),
  manifest: Object.freeze([]),
  exec_plan: Object.freeze([]),
  project: Object.freeze([])
});

export const PROVENANCE_TARGET_TYPES = deepFreeze({
  claim: { evidence: ['evidence'] },
  evidence: {
    sources: ['driver', 'result'],
    counterevidence: ['evidence'],
    supported_claims: ['claim'],
    writing_destinations: ['writing']
  },
  result: { run: ['run'], follow_up: ['action'] },
  run: { experiment: ['experiment'], manifest: ['manifest'] },
  driver: { actions: ['action'] },
  artifact: { producer_action: ['action'] },
  action: {
    driver: ['driver'],
    inputs: ['artifact', 'action', 'driver', 'evidence', 'experiment', 'manifest', 'result', 'run'],
    outputs: ['artifact', 'action', 'claim', 'decision', 'evidence', 'result', 'writing'],
    dependencies: ['artifact', 'action', 'driver', 'experiment', 'manifest', 'result', 'run']
  },
  writing: {
    claims: ['claim'],
    concern: ['driver'],
    evidence_or_reason: ['evidence', 'decision'],
    manuscript_changes: ['writing'],
    covered_actions: ['action'],
    response_blocks: ['writing']
  },
  incident: { evidence: ['evidence', 'result', 'run'] },
  risk: { evidence: ['evidence', 'result', 'run'] },
  decision: { impact: ['action', 'artifact', 'claim', 'decision', 'driver', 'evidence', 'exec_plan', 'experiment', 'incident', 'manifest', 'project', 'result', 'risk', 'run', 'writing'] }
});

export const PROVENANCE_LINK_SHAPES = deepFreeze({
  artifact: { producer_action: 'scalar' },
  claim: { evidence: 'array' },
  evidence: { sources: 'sources', counterevidence: 'array', supported_claims: 'array', writing_destinations: 'array' },
  result: { run: 'scalar', follow_up: 'array' },
  run: { experiment: 'scalar', manifest: 'scalar' },
  driver: { actions: 'array' },
  action: { driver: 'scalar', inputs: 'array', outputs: 'array', dependencies: 'array' },
  writing: { claims: 'array', concern: 'scalar', evidence_or_reason: 'array', manuscript_changes: 'array', covered_actions: 'array', response_blocks: 'array' },
  incident: { evidence: 'array' },
  risk: { evidence: 'array' },
  decision: { impact: 'array' }
});

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function byId(records) {
  const index = new Map();
  for (const record of records.values()) {
    const matches = index.get(record.attributes.id) ?? [];
    matches.push(record);
    index.set(record.attributes.id, matches);
  }
  for (const matches of index.values()) matches.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return index;
}

function recordNode(record) {
  return Object.freeze({ id: record.attributes.id, type: record.attributes.type, path: record.path });
}

function freezeObjects(items) {
  return deepFreeze(items);
}

/** @internal */
export function inspectProvenanceLinkValues(record, field) {
  const shape = PROVENANCE_LINK_SHAPES[record.attributes.type]?.[field];
  if (!Object.hasOwn(record.attributes, field)) return { targets: [], invalidValues: [] };
  const value = record.attributes[field];
  if (shape === 'sources') {
    return {
      targets: Array.isArray(value) ? uniqueSorted(value.filter(item => typeof item === 'string' && ID.test(item))) : [],
      invalidValues: []
    };
  }
  const declared = shape === 'array' && Array.isArray(value) ? value : [value];
  const validShape = shape === 'scalar' ? !Array.isArray(value) : shape === 'array' && Array.isArray(value);
  if (!validShape) return { targets: [], invalidValues: declared };
  const targets = [];
  const invalidValues = [];
  for (const item of declared) {
    if (typeof item === 'string' && ID.test(item)) targets.push(item);
    else invalidValues.push(item);
  }
  return { targets: uniqueSorted(targets), invalidValues };
}

/**
 * Classify every non-canonical-ID Evidence source against the project registry.
 * @internal
 * @param {Readonly<Record<string, unknown>>|undefined} project
 * @param {RecordRef} record
 * @returns {{externalSources: object[], brokenSources: object[]}}
 */
export function inspectEvidenceSources(project, record) {
  const externalSources = [];
  const brokenSources = [];
  if (!Array.isArray(record.attributes.sources)) {
    return {
      externalSources,
      brokenSources: [{ from: record.attributes.id, field: 'sources', ref: record.attributes.sources ?? '<missing>', code: 'INVALID_SOURCE_COLLECTION' }]
    };
  }
  const sourceValues = [...record.attributes.sources];
  const resourceRefs = sourceValues.filter(value => typeof value !== 'string' || !ID.test(value));
  resourceRefs.sort((left, right) => String(left).localeCompare(String(right), 'en'));
  for (const ref of resourceRefs) {
    if (typeof ref !== 'string') {
      brokenSources.push({ from: record.attributes.id, field: 'sources', ref, code: 'INVALID_SOURCE' });
      continue;
    }
    try {
      const resolved = resolveResourceRef(project, ref);
      externalSources.push({ from: record.attributes.id, field: 'sources', ref, uri: resolved.uri });
    } catch (error) {
      brokenSources.push({ from: record.attributes.id, field: 'sources', ref, code: error.code ?? 'RESOURCE_CONFIG' });
    }
  }
  return { externalSources, brokenSources };
}

/**
 * @typedef {Object} RecordRef
 * @property {string} id
 * @property {string} type
 * @property {string} path
 * @property {Readonly<Record<string, unknown>>} attributes
 */

/**
 * @typedef {Object} TraceGraph
 * @property {string} rootId
 * @property {ReadonlyArray<object>} nodes
 * @property {ReadonlyArray<object>} edges
 * @property {ReadonlySet<string>} types
 * @property {ReadonlyArray<object>} brokenLinks
 * @property {ReadonlyArray<ReadonlyArray<string>>} cycles
 * @property {ReadonlyArray<object>} externalSources
 * @property {ReadonlyArray<object>} brokenSources
 * @property {ReadonlyArray<ReadonlyArray<string>>} paths
 */

/**
 * Trace a Claim through declared, type-constrained frontmatter links in a catalog.
 * Body wikilinks are intentionally outside this authority surface.
 * @param {{values:Function}} records
 * @param {string} claimId
 * @returns {TraceGraph}
 */
export function traceClaimCatalog(records, claimId) {
  const index = byId(records);
  const roots = index.get(claimId) ?? [];
  if (roots.length === 0) throw new ResearchOSError('RECORD_NOT_FOUND', `Record not found: ${claimId}`);
  if (roots.length > 1) throw new ResearchOSError('CONFLICT', `Record ID is not unique: ${claimId}`);
  if (roots[0].attributes.type !== 'claim') throw new ResearchOSError('TRACE_ROOT_TYPE', `Trace root must be a Claim: ${claimId}`);

  const project = [...records.values()].find(record => record.attributes.type === 'project' && record.path === 'PROJECT.md')?.attributes;
  const nodes = new Map();
  const edges = [];
  const brokenLinks = [];
  const externalSources = [];
  const brokenSources = [];
  const cycles = [];
  const expanded = new Set();
  const cycleKeys = new Set();

  function walk(id, stack) {
    const matches = index.get(id) ?? [];
    if (matches.length !== 1) return;
    const record = matches[0];
    if (!nodes.has(id)) nodes.set(id, recordNode(record));
    const cycleStart = stack.indexOf(id);
    if (cycleStart !== -1) {
      const cycle = [...stack.slice(cycleStart), id];
      const key = cycle.join('>');
      if (!cycleKeys.has(key)) {
        cycles.push(cycle);
        cycleKeys.add(key);
      }
      return;
    }
    if (expanded.has(id)) return;
    expanded.add(id);

    const targets = [];
    for (const field of PROVENANCE_LINK_FIELDS[record.attributes.type] ?? []) {
      const inspectedLinks = inspectProvenanceLinkValues(record, field);
      for (const value of inspectedLinks.invalidValues) {
        brokenLinks.push({ from: id, field, value: value ?? '<missing>', code: 'INVALID_LINK_VALUE' });
      }
      for (const target of inspectedLinks.targets) {
        const targetMatches = index.get(target) ?? [];
        if (targetMatches.length === 0) {
          brokenLinks.push({ from: id, field, target, code: 'MISSING_TARGET' });
          continue;
        }
        if (targetMatches.length > 1) {
          brokenLinks.push({ from: id, field, target, code: 'AMBIGUOUS_TARGET' });
          continue;
        }
        const allowedTypes = PROVENANCE_TARGET_TYPES[record.attributes.type]?.[field] ?? [];
        const actualType = targetMatches[0].attributes.type;
        if (!allowedTypes.includes(actualType)) {
          brokenLinks.push({ from: id, field, target, code: 'WRONG_LINK_TYPE', actualType, allowedTypes: [...allowedTypes] });
          continue;
        }
        edges.push({ from: id, to: target, field });
        targets.push(target);
      }
      if (record.attributes.type === 'evidence' && field === 'sources') {
        const inspected = inspectEvidenceSources(project, record);
        externalSources.push(...inspected.externalSources);
        brokenSources.push(...inspected.brokenSources);
      }
    }
    for (const target of targets) walk(target, [...stack, id]);
  }

  walk(claimId, []);

  const adjacency = new Map();
  for (const edge of edges) {
    if (!index.has(edge.to) || (index.get(edge.to)?.length ?? 0) !== 1) continue;
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const paths = [];
  function collectPaths(id, path) {
    const nextPath = [...path, id];
    const targets = adjacency.get(id) ?? [];
    const available = targets.filter(target => !nextPath.includes(target));
    if (available.length === 0) {
      paths.push(nextPath);
      return;
    }
    for (const target of targets) {
      if (!nextPath.includes(target)) collectPaths(target, nextPath);
    }
  }
  collectPaths(claimId, []);

  const nodeList = Object.freeze([...nodes.values()]);
  return Object.freeze({
    rootId: claimId,
    nodes: nodeList,
    edges: freezeObjects(edges),
    types: new ReadonlySet(nodeList.map(node => node.type)),
    brokenLinks: freezeObjects(brokenLinks),
    brokenSources: freezeObjects(brokenSources),
    externalSources: freezeObjects(externalSources),
    cycles: Object.freeze(cycles.map(cycle => Object.freeze(cycle))),
    paths: Object.freeze(paths.map(path => Object.freeze(path)))
  });
}

/**
 * Filesystem wrapper around the pure catalog-backed Claim trace.
 * @param {string} projectRoot
 * @param {string} claimId
 * @returns {Promise<TraceGraph>}
 */
export async function traceClaim(projectRoot, claimId) {
  return traceClaimCatalog(await discoverRecords(projectRoot), claimId);
}
