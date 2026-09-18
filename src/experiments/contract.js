import { ResearchOSError } from '../lib/errors.js';
import { deepFreeze } from '../lib/readonly.js';
import {
  MANIFEST_INPUT_FIELDS, MANIFEST_MACHINE_FIELDS, canonicalJson, sha256Json, stableJson,
  verifyNormalizedManifest, verifyProjectAuthoritySnapshot
} from './manifest.js';

export const MANDATORY_MANIFEST_FIELDS = MANIFEST_INPUT_FIELDS;
export const CONTRACT_DIFF_STATUSES = Object.freeze(['PASS', 'BLOCK', 'UNKNOWN', 'ALLOWED_DEVIATION']);
const CONTRACT_KEYS = Object.freeze(['id', 'version', 'approved_use', 'requirements', 'semantic_checks', 'allowed_deviations']);
const CHECK_KEYS = Object.freeze(['name', 'field', 'required', 'evidence', 'risk']);
const DEVIATION_KEYS = Object.freeze(['field', 'actual', 'waiver_id', 'evidence', 'risk']);
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const WAIVER_ID = /^WVR-[0-9]{3,}$/u;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message) { throw new ResearchOSError('CONTRACT_INVALID', message); }
function object(value) { return value && !Array.isArray(value) && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function single(value) { return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2028\u2029\0]/u.test(value); }

function exactKeys(value, expected, label) {
  if (!object(value)) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields must be exactly: ${expected.join(', ')}`);
}

function validPath(path) { return PATH.test(path) && !path.split('.').some(segment => UNSAFE.has(segment)); }

function lookup(value, path) {
  let current = value;
  for (const segment of path.split('.')) {
    if (!object(current) || !Object.hasOwn(current, segment)) return { present: false, value: null };
    current = current[segment];
  }
  return { present: true, value: canonicalJson(current) };
}

function equal(left, right) { return stableJson(left) === stableJson(right); }

function validateContract(raw) {
  let contract;
  try { contract = canonicalJson(raw); } catch (error) { fail(`Contract must be exact JSON: ${error.message}`); }
  exactKeys(contract, CONTRACT_KEYS, 'Experiment Contract');
  for (const field of ['id', 'version', 'approved_use']) if (!single(contract[field])) fail(`${field} must be meaningful`);
  if (!object(contract.requirements) || !Array.isArray(contract.semantic_checks) || !Array.isArray(contract.allowed_deviations)) fail('Contract collections are invalid');
  const missing = MANDATORY_MANIFEST_FIELDS.filter(field => !Object.hasOwn(contract.requirements, field));
  if (missing.length > 0) fail(`Missing mandatory Manifest requirements: ${missing.join(', ')}`);
  for (const field of Object.keys(contract.requirements)) if (!validPath(field)) fail(`Invalid requirement path: ${field}`);

  const itemPaths = new Set(Object.keys(contract.requirements));
  const names = new Set();
  for (const check of contract.semantic_checks) {
    exactKeys(check, CHECK_KEYS, 'semantic check');
    for (const field of ['name', 'field', 'evidence', 'risk']) if (!single(check[field])) fail(`semantic check ${field} must be meaningful`);
    if (!validPath(check.field) || names.has(check.name) || itemPaths.has(check.field)) fail(`Duplicate or invalid semantic check: ${check.field}`);
    const parent = MANDATORY_MANIFEST_FIELDS.find(field => check.field.startsWith(`${field}.`));
    if (parent) {
      const parentRequired = lookup(contract.requirements[parent], check.field.slice(parent.length + 1));
      if (parentRequired.present && !equal(parentRequired.value, check.required)) fail(`Semantic check contradicts mandatory parent: ${check.field}`);
      if (!parentRequired.present && !object(contract.requirements[parent])) fail(`Semantic check cannot descend through a non-object mandatory parent: ${check.field}`);
    }
    names.add(check.name);
    itemPaths.add(check.field);
  }
  const deviations = new Set();
  for (const deviation of contract.allowed_deviations) {
    exactKeys(deviation, DEVIATION_KEYS, 'allowed deviation');
    for (const field of ['field', 'waiver_id', 'evidence', 'risk']) if (!single(deviation[field])) fail(`allowed deviation ${field} must be meaningful`);
    if (!WAIVER_ID.test(deviation.waiver_id)) fail(`Invalid deviation waiver ID: ${deviation.waiver_id}`);
    if (!validPath(deviation.field) || !itemPaths.has(deviation.field) || deviations.has(deviation.field)) fail(`Invalid or duplicate deviation field: ${deviation.field}`);
    deviations.add(deviation.field);
  }
  return deepFreeze(contract);
}

function manifestIdentity(raw, project) {
  const snapshot = canonicalJson(raw);
  const exactCompleteKeys = [...MANIFEST_INPUT_FIELDS, ...MANIFEST_MACHINE_FIELDS].sort((a, b) => a.localeCompare(b, 'en'));
  const actualKeys = Object.keys(snapshot).sort((a, b) => a.localeCompare(b, 'en'));
  const completeShape = actualKeys.length === exactCompleteKeys.length && actualKeys.every((key, index) => key === exactCompleteKeys[index]);
  if (completeShape) {
    const verified = verifyNormalizedManifest(snapshot, { project });
    return { snapshot: verified, hash: verified.normalized_hash, complete: true, authority: verified.project_authority, authorityHash: verified.project_authority_hash, codeRoot: verified.code_root };
  }
  const authority = verifyProjectAuthoritySnapshot(snapshot, project);
  const hash = sha256Json({ manifest_complete: false, manifest_snapshot: snapshot });
  return { snapshot, hash, complete: false, authority, authorityHash: sha256Json(authority), codeRoot: authority.code_root };
}

/** @typedef {'PASS'|'BLOCK'|'UNKNOWN'|'ALLOWED_DEVIATION'} ContractDiffStatus */
/** @typedef {{field:string,required:unknown,actual:unknown,actualPresent:boolean,status:ContractDiffStatus,evidence:string,risk:string,waiver_id?:string}} ContractDiffItem */
/** @typedef {Readonly<Record<string, unknown>>} ContractDiff */

export function compareContract(rawContract, rawManifest, options = {}) {
  if (!object(options) || Object.keys(options).some(key => key !== 'project') || !options.project) fail('compareContract requires the authoritative Project');
  const contract = validateContract(rawContract);
  let identity;
  try { identity = manifestIdentity(rawManifest, options.project); } catch (error) { fail(`Manifest identity is invalid: ${error.message}`); }
  const deviations = new Map(contract.allowed_deviations.map(item => [item.field, item]));
  const declarations = [
    ...Object.entries(contract.requirements).map(([field, required]) => ({ field, required, evidence: `Mandatory Manifest field: ${field}`, risk: 'The approved implementation contract is not exactly satisfied.' })),
    ...contract.semantic_checks.map(check => ({ field: check.field, required: check.required, evidence: check.evidence, risk: check.risk }))
  ];
  const items = declarations.map(declaration => {
    const actual = lookup(identity.snapshot, declaration.field);
    const required = canonicalJson(declaration.required);
    let status = 'UNKNOWN';
    let waiverId;
    if (actual.present && equal(required, actual.value)) status = 'PASS';
    else if (actual.present) {
      const deviation = deviations.get(declaration.field);
      if (deviation && equal(actual.value, deviation.actual)) { status = 'ALLOWED_DEVIATION'; waiverId = deviation.waiver_id; }
      else status = 'BLOCK';
    }
    const metadata = status === 'ALLOWED_DEVIATION' ? deviations.get(declaration.field) : declaration;
    return { field: declaration.field, required, actual: actual.value, actualPresent: actual.present, status, evidence: metadata.evidence, risk: metadata.risk, ...(waiverId ? { waiver_id: waiverId } : {}) };
  }).sort((left, right) => left.field.localeCompare(right.field, 'en'));
  const summary = Object.fromEntries(CONTRACT_DIFF_STATUSES.map(status => [status, items.filter(item => item.status === status).length]));
  const contractHash = sha256Json(contract);
  const payload = canonicalJson({
    contractId: contract.id,
    contractVersion: contract.version,
    approvedUse: contract.approved_use,
    contractHash,
    manifestHash: identity.hash,
    manifestComplete: identity.complete,
    projectId: identity.authority.project_id,
    projectAuthorityHash: identity.authorityHash,
    codeRoot: identity.codeRoot,
    contractSnapshot: contract,
    manifestSnapshot: identity.snapshot,
    items,
    summary
  });
  return deepFreeze({ ...payload, diffHash: sha256Json(payload) });
}
