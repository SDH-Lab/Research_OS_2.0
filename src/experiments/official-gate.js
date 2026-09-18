import { ResearchOSError } from '../lib/errors.js';
import { deepFreeze } from '../lib/readonly.js';
import { compareContract } from './contract.js';
import { canonicalJson, isValidTimestamp, sha256Json, stableJson, trustedDate } from './manifest.js';

const WAIVER_KEYS = Object.freeze(['id', 'contract_id', 'contract_version', 'diff_hash', 'field', 'status', 'approved_use', 'reason', 'approved_by', 'approved_at', 'expires_at']);
const RECEIPT_SCOPE = 'provenance-promotion-only; does-not-execute-command-or-set-run-official';

function blocked(message) { throw new ResearchOSError('OFFICIAL_RUN_BLOCKED', `OFFICIAL_RUN_BLOCKED: ${message}`); }
function object(value) { return value && !Array.isArray(value) && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function single(value) { return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2028\u2029\0]/u.test(value); }
function exactKeys(value, expected, label) {
  if (!object(value)) blocked(`${label} must be a plain object`);
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) blocked(`${label} has an invalid shape`);
}
function validTime(value) {
  return isValidTimestamp(value);
}
function validateWaiver(waiver, diff, now) {
  exactKeys(waiver, WAIVER_KEYS, 'waiver');
  for (const field of ['id', 'contract_id', 'contract_version', 'diff_hash', 'field', 'status', 'approved_use', 'reason', 'approved_by']) if (!single(waiver[field])) blocked(`Invalid waiver ${field}`);
  if (!/^WVR-[0-9]{3,}$/u.test(waiver.id) || !['UNKNOWN', 'ALLOWED_DEVIATION'].includes(waiver.status)) blocked('Invalid waiver ID or status');
  if (!validTime(waiver.approved_at) || !validTime(waiver.expires_at)) blocked('Invalid waiver timestamps');
  const approved = Date.parse(waiver.approved_at); const expires = Date.parse(waiver.expires_at);
  if (approved > now || now >= expires || approved >= expires) blocked('Waiver is expired or not yet valid');
  if (waiver.contract_id !== diff.contractId || waiver.contract_version !== diff.contractVersion || waiver.diff_hash !== diff.diffHash || waiver.approved_use !== diff.approvedUse) blocked('Waiver binding does not match Diff');
}

/** @typedef {Readonly<Record<string, unknown>>} OfficialReceipt */

export function authorizeOfficialRun(input, options = {}) {
  let safeInput;
  try { safeInput = canonicalJson(input); } catch (error) { blocked(`Authorization input must be exact JSON: ${error.message}`); }
  exactKeys(safeInput, ['contractDiff', 'mechanicalSmoke', 'semanticSmoke', 'waivers'], 'authorization input');
  if (!object(options) || Object.keys(options).some(key => !['clock', 'project'].includes(key)) || !options.project) blocked('Authoritative Project is required');
  let fresh;
  try {
    fresh = compareContract(safeInput.contractDiff.contractSnapshot, safeInput.contractDiff.manifestSnapshot, { project: options.project });
    if (stableJson(fresh) !== stableJson(safeInput.contractDiff)) blocked('Contract Diff is not the exact recomputed snapshot comparison');
  } catch (error) {
    if (error instanceof ResearchOSError && error.code === 'OFFICIAL_RUN_BLOCKED') throw error;
    blocked(`Contract Diff cannot be recomputed: ${error.message}`);
  }
  if (!fresh.manifestComplete) blocked('An official receipt requires a complete verified normalized Manifest; partial Manifests are diagnostic-only');
  if (safeInput.mechanicalSmoke !== 'pass' || safeInput.semanticSmoke !== 'pass') blocked('Both smoke checks must be exactly pass');
  if (!Array.isArray(safeInput.waivers)) blocked('waivers must be an array');
  if (fresh.summary.BLOCK > 0) blocked('BLOCK is never waivable');
  let now;
  try { now = trustedDate(options.clock, 'OFFICIAL_RUN_BLOCKED'); } catch (error) { blocked(error.message); }
  const ids = new Set();
  for (const waiver of safeInput.waivers) {
    validateWaiver(waiver, fresh, now.epoch);
    if (ids.has(waiver.id)) blocked('Duplicate waiver ID');
    ids.add(waiver.id);
  }
  const applied = new Set();
  for (const item of fresh.items) {
    if (!['UNKNOWN', 'ALLOWED_DEVIATION'].includes(item.status)) continue;
    const candidates = safeInput.waivers.filter(waiver => waiver.field === item.field && waiver.status === item.status && (item.status !== 'ALLOWED_DEVIATION' || waiver.id === item.waiver_id));
    if (candidates.length !== 1 || applied.has(candidates[0].id)) blocked(`Exactly one unique waiver is required for ${item.field}`);
    applied.add(candidates[0].id);
  }
  if (applied.size !== safeInput.waivers.length) blocked('Extraneous waiver supplied');
  const payload = {
    contractId: fresh.contractId,
    contractVersion: fresh.contractVersion,
    contractHash: fresh.contractHash,
    manifestHash: fresh.manifestHash,
    manifestComplete: fresh.manifestComplete,
    diffHash: fresh.diffHash,
    projectId: fresh.projectId,
    projectAuthorityHash: fresh.projectAuthorityHash,
    codeRoot: fresh.codeRoot,
    timestamp: now.iso,
    approvedUse: fresh.approvedUse,
    appliedWaiverIds: [...applied].sort((a, b) => a.localeCompare(b, 'en')),
    authorizationScope: RECEIPT_SCOPE
  };
  return deepFreeze({ ...payload, receiptHash: sha256Json(payload) });
}
