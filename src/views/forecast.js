import { types } from 'node:util';
import { isScheduledActionStatus } from '../records/action-state.js';
import { ResearchOSError } from '../lib/errors.js';
import { deepFreeze, ReadonlyMap } from '../lib/readonly.js';
import { safeDataClone, safeOwnDataProperties } from '../lib/safe-data.js';
import {
  isCanonicalRecordLocation, isValidDate, isValidDateTime, isValidIanaTimeZone,
  schemaForRecordType, validateRecord, validateStatusHistory
} from '../validation/validator.js';

export const SIZE_WEIGHTS = Object.freeze({ small: 1, medium: 2, large: 4, unestimated: 2 });
const ACTION_DOMAINS = Object.freeze(['experiment', 'analysis', 'writing', 'coordination', 'unclassified']);
const ACTION_SIZES = Object.freeze(['small', 'medium', 'large', 'unestimated']);
const IN_PROGRESS = new Set(['in_progress', 'review', 'verified', 'reopened']);
const QUALIFYING_RESULTS = new Set(['adopted', 'excluded', 'credible_negative', 'uncertain']);
const DEPENDENCY_TYPES = new Set(['action', 'driver', 'experiment', 'manifest', 'result', 'run', 'artifact']);
const DAY_MS = 86_400_000;

function issue(code, path, message, relatedIds = []) {
  return { severity: 'warning', code, path, message, relatedIds: [...new Set(relatedIds)].sort((a, b) => a.localeCompare(b, 'en')) };
}

function sortIssues(items) {
  return items.sort((left, right) => left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'en'));
}

function validation(message, details = []) {
  return new ResearchOSError('VALIDATION', message, details);
}

function catalogEntries(catalog) {
  try {
    if (types.isProxy(catalog)) throw validation('Forecast catalog cannot be a Proxy');
    if (catalog instanceof Map) return [...Map.prototype.entries.call(catalog)];
    if (catalog instanceof ReadonlyMap) return [...ReadonlyMap.prototype.entries.call(catalog)];
  } catch (error) {
    if (error instanceof ResearchOSError) throw error;
    throw validation(`Forecast catalog is not safely readable: ${error.message}`);
  }
  throw validation('Forecast catalog must be a path-keyed Map or ReadonlyMap of RecordRefs');
}

function recordsFromCatalog(catalog) {
  const records = [];
  for (const [key, candidate] of catalogEntries(catalog)) {
    if (typeof key !== 'string') throw validation('Forecast catalog keys must be primitive path strings');
    let record;
    try {
      record = safeDataClone(candidate, `catalog[${key}]`);
    } catch (error) {
      throw validation(`Forecast record at ${key} is not safely readable: ${error.message}`);
    }
    if (!record || Array.isArray(record) || typeof record !== 'object' || !record.attributes || Array.isArray(record.attributes) || typeof record.attributes !== 'object') {
      throw validation(`Forecast catalog entry ${key} must be a RecordRef with attributes`);
    }
    if (record.path !== key) throw validation(`Forecast catalog key must exactly equal RecordRef.path: ${key}`);
    if (typeof record.id !== 'string' || typeof record.type !== 'string' || record.id !== record.attributes.id || record.type !== record.attributes.type) {
      throw validation(`Forecast RecordRef identity is inconsistent: ${key}`);
    }
    const normalized = { id: record.id, type: record.type, path: record.path, attributes: record.attributes };
    records.push(normalized);
  }
  const byId = new Map();
  for (const record of records) byId.set(record.id, [...(byId.get(record.id) ?? []), record]);
  const duplicateIssues = [];
  for (const [id, matches] of byId) {
    if (matches.length < 2) continue;
    for (const match of matches) duplicateIssues.push(issue('DUPLICATE_RECORD_ID', match.path, `Record ID appears at ${matches.length} paths`, [id]));
    for (const action of records.filter(record => record.type === 'action' && Array.isArray(record.attributes.dependencies) && record.attributes.dependencies.includes(id))) {
      duplicateIssues.push(issue('DEPENDENCY_AMBIGUOUS', action.path, `Action ${action.id} dependency ${id} resolves to ${matches.length} records`, [action.id, id]));
    }
  }
  if (duplicateIssues.length > 0) throw validation('Forecast record IDs must be unique', sortIssues(duplicateIssues));
  for (const record of records) {
    if (record.type === 'action') {
      if (!isCanonicalRecordLocation(record)) throw validation(`Action is not in its canonical path: ${record.path}`, [issue('CANONICAL_LOCATION', record.path, 'Action must be plans/actions/<ID>.md', [record.id])]);
      const schemaIssues = validateRecord('action', record.attributes);
      const historyIssues = validateStatusHistory(record.attributes, record.path);
      if (schemaIssues.length > 0 || historyIssues.length > 0) throw validation(`Action authority is invalid: ${record.path}`, [...schemaIssues, ...historyIssues]);
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function utcDate(value) { return new Date(`${value}T00:00:00Z`); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(value, days) { const date = utcDate(value); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }
function daysBetween(left, right) { return Math.floor((utcDate(right) - utcDate(left)) / DAY_MS); }
function weekStart(value) {
  const date = utcDate(value);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return isoDate(date);
}

function localDate(value, timezone) {
  if (isValidDate(value)) return value;
  if (!isValidDateTime(value)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function normalizeCalendar(calendar) {
  const value = safeDataClone(calendar, 'capacityCalendar');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw validation('Capacity calendar must be an object');
  if (!isValidDate(value.asOf)) throw validation('Capacity calendar asOf must be a valid YYYY-MM-DD date');
  if (!isValidIanaTimeZone(value.timezone)) throw validation('Capacity calendar timezone must be a valid IANA timezone');
  if (!Number.isFinite(value.defaultWeeklyUnits) || value.defaultWeeklyUnits <= 0) throw validation('defaultWeeklyUnits must be a finite positive number');
  if (!Array.isArray(value.weeks)) throw validation('Capacity calendar weeks must be an array');
  const seen = new Set();
  const weeks = value.weeks.map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== 'object' || !isValidDate(item.weekStart) || weekStart(item.weekStart) !== item.weekStart || !Number.isFinite(item.availableUnits) || item.availableUnits < 0 || typeof item.reason !== 'string' || item.reason.trim().length === 0) {
      throw validation(`Capacity calendar week ${index} is invalid`);
    }
    if (seen.has(item.weekStart)) throw validation(`Capacity calendar week is duplicated: ${item.weekStart}`);
    seen.add(item.weekStart);
    return { weekStart: item.weekStart, availableUnits: item.availableUnits, reason: item.reason };
  }).sort((left, right) => left.weekStart.localeCompare(right.weekStart, 'en'));
  return { asOf: value.asOf, timezone: value.timezone, defaultWeeklyUnits: value.defaultWeeklyUnits, weeks };
}

function latestTransition(attributes, target) {
  if (!Array.isArray(attributes.status_history)) return null;
  return attributes.status_history
    .filter(entry => entry && typeof entry === 'object' && entry.to === target && isValidDateTime(entry.at))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1)?.at ?? null;
}

function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const key = record.attributes[field];
    if (typeof key === 'string') counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function authorityCutoffIssues(records, calendar) {
  const issues = [];
  const check = (record, field, value) => {
    const date = localDate(value, calendar.timezone);
    if (date && date > calendar.asOf) issues.push(issue(
      'FORECAST_AS_OF_BEFORE_AUTHORITY', record.path,
      `${field} resolves to ${date} after forecast asOf ${calendar.asOf}`, [record.id]
    ));
  };
  for (const record of records) {
    for (const field of ['created', 'updated', 'verified_at']) check(record, field, record.attributes[field]);
    if (Array.isArray(record.attributes.status_history)) {
      for (const [index, entry] of record.attributes.status_history.entries()) check(record, `status_history[${index}].at`, entry?.at);
    }
    if (record.type === 'action' && Array.isArray(record.attributes.blockers)) {
      for (const [index, blocker] of record.attributes.blockers.entries()) {
        check(record, `blockers[${index}].since`, blocker?.since);
        check(record, `blockers[${index}].resolved_at`, blocker?.resolved_at);
      }
    }
  }
  return issues;
}

function summarizeHandoffs(records, calendar, issues) {
  const results = records.filter(record => record.type === 'result' && record.attributes.status === 'closed' && QUALIFYING_RESULTS.has(record.attributes.classification));
  const evidence = records.filter(record => record.type === 'evidence');
  const completed = [];
  const pending = [];
  for (const result of results) {
    const id = result.id;
    const resultAt = latestTransition(result.attributes, 'closed');
    const linked = evidence.filter(packet => Array.isArray(packet.attributes.sources) && packet.attributes.sources.includes(id));
    const closed = linked.filter(packet => packet.attributes.status === 'closed').sort((left, right) => left.path.localeCompare(right.path, 'en'));
    if (!resultAt) {
      issues.push(issue('HANDOFF_ACCEPTANCE_TIME_MISSING', result.path, `Closed Result ${id} has no valid close transition`, [id]));
      pending.push({ resultId: id, resultPath: result.path, evidencePaths: closed.map(item => item.path), reason: 'acceptance_time_missing' });
      continue;
    }
    if (closed.length === 0) {
      pending.push({ resultId: id, resultPath: result.path, evidencePaths: linked.map(item => item.path).sort(), reason: linked.length > 0 ? 'evidence_not_closed' : 'missing_evidence_packet' });
      continue;
    }
    if (closed.length > 1) {
      issues.push(issue('HANDOFF_AMBIGUOUS_PACKET', result.path, `Result ${id} has multiple closed Evidence Packets`, [id, ...closed.map(item => item.id)]));
      pending.push({ resultId: id, resultPath: result.path, evidencePaths: closed.map(item => item.path), reason: 'ambiguous_closed_evidence' });
      continue;
    }
    const packet = closed[0];
    const packetAt = latestTransition(packet.attributes, 'closed');
    if (!packetAt) {
      issues.push(issue('HANDOFF_PACKET_TIME_MISSING', packet.path, `Closed Evidence ${packet.id} has no valid close transition`, [id, packet.id]));
      pending.push({ resultId: id, resultPath: result.path, evidencePaths: [packet.path], reason: 'packet_time_missing' });
      continue;
    }
    const delay = daysBetween(localDate(resultAt, calendar.timezone), localDate(packetAt, calendar.timezone));
    if (delay < 0) {
      issues.push(issue('HANDOFF_NEGATIVE_DELAY', packet.path, `Evidence ${packet.id} predates accepted Result ${id}`, [id, packet.id]));
      pending.push({ resultId: id, resultPath: result.path, evidencePaths: [packet.path], reason: 'negative_chronology' });
      continue;
    }
    completed.push({ resultId: id, resultPath: result.path, evidenceId: packet.id, evidencePath: packet.path, acceptedAt: resultAt, readyAt: packetAt, delayDays: delay });
  }
  completed.sort((left, right) => left.resultId.localeCompare(right.resultId, 'en'));
  pending.sort((left, right) => left.resultId.localeCompare(right.resultId, 'en'));
  const delays = completed.map(item => item.delayDays).sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  return { completed, pending, medianDelayDays: delays.length === 0 ? null : delays.length % 2 === 1 ? delays[middle] : (delays[middle - 1] + delays[middle]) / 2 };
}

function assertHandoffAuthority(records) {
  const problems = [];
  for (const record of records.filter(item => ['result', 'evidence'].includes(item.type))) {
    if (!isCanonicalRecordLocation(record)) {
      problems.push(issue('HANDOFF_NONCANONICAL', record.path, `${record.type} is not in its canonical location`, [record.id]));
      continue;
    }
    const schema = schemaForRecordType(record.type);
    if (!schema) {
      problems.push(issue('HANDOFF_SCHEMA_UNREGISTERED', record.path, `${record.type} has no registered schema`, [record.id]));
      continue;
    }
    const schemaIssues = validateRecord(schema, record.attributes);
    const historyIssues = validateStatusHistory(record.attributes, record.path);
    if (schemaIssues.length > 0) problems.push(issue('HANDOFF_SCHEMA_INVALID', record.path, `${record.type} fails its registered schema`, [record.id]));
    if (historyIssues.length > 0) problems.push(issue('HANDOFF_HISTORY_INVALID', record.path, `${record.type} has invalid lifecycle authority`, [record.id]));
  }
  if (problems.length > 0) throw validation('Result-to-Evidence handoff authority is invalid', sortIssues(problems));
}

/** Summarize canonical work without treating non-Action records as scheduling units. */
export function summarizeActions(catalog, calendar) {
  try {
    const normalizedCalendar = normalizeCalendar(calendar);
    const records = recordsFromCatalog(catalog);
    assertHandoffAuthority(records);
    const actions = records.filter(record => record.type === 'action');
    const remaining = actions.filter(record => isScheduledActionStatus(record.attributes.status));
    const issues = authorityCutoffIssues(records, normalizedCalendar);
    for (const action of remaining) {
      if (!ACTION_DOMAINS.includes(action.attributes.domain)) issues.push(issue('ACTION_DOMAIN_INVALID', action.path, 'Action domain is invalid', [action.id]));
      else if (action.attributes.domain === 'unclassified') issues.push(issue('ACTION_DOMAIN_UNCLASSIFIED', action.path, 'Action domain is not classified', [action.id]));
      if (!ACTION_SIZES.includes(action.attributes.size)) issues.push(issue('ACTION_SIZE_INVALID', action.path, 'Action size is invalid', [action.id]));
      else if (action.attributes.size === 'unestimated') issues.push(issue('ACTION_SIZE_UNESTIMATED', action.path, 'Action size is not estimated; median fallback weight 2 is used', [action.id]));
    }

    const blockers = [];
    const blockerHistory = [];
    for (const action of actions) for (const blocker of action.attributes.blockers) {
      const since = localDate(blocker.since, normalizedCalendar.timezone);
      const details = { actionId: action.id, path: action.path, id: blocker.id, category: blocker.category, criticalPath: blocker.critical_path, rootCause: blocker.root_cause, description: blocker.description, owner: blocker.owner, since: blocker.since, nextUnblockAction: blocker.next_unblock_action, reviewAt: blocker.review_at };
      if (blocker.status === 'resolved') {
        const resolved = localDate(blocker.resolved_at, normalizedCalendar.timezone);
        blockerHistory.push({ ...details, resolvedAt: blocker.resolved_at, resolution: blocker.resolution, durationDays: since && resolved ? daysBetween(since, resolved) : null });
        continue;
      }
      if (!isScheduledActionStatus(action.attributes.status)) continue;
      let ageDays = since ? daysBetween(since, normalizedCalendar.asOf) : null;
      if (!since && blocker.since !== null) issues.push(issue('BLOCKER_DATE_INVALID', action.path, 'Active blocker since is invalid', [action.id]));
      else if (ageDays !== null && ageDays < 0) { issues.push(issue('BLOCKER_IN_FUTURE', action.path, 'Active blocker starts after canonical asOf', [action.id])); ageDays = 0; }
      blockers.push({ ...details, ageDays });
    }
    blockers.sort((left, right) => left.path.localeCompare(right.path, 'en') || left.description.localeCompare(right.description, 'en'));

    const currentWeek = weekStart(normalizedCalendar.asOf);
    const createdDates = actions.map(action => localDate(action.attributes.created, normalizedCalendar.timezone)).filter(Boolean);
    // A creation week is only partially exposed, even when creation happened on Monday.
    // Calibration begins with the first Monday strictly after that week.
    const firstWeek = createdDates.length > 0 ? addDays(weekStart(createdDates.sort()[0]), 7) : currentWeek;
    const weeks = [];
    for (let cursor = firstWeek; cursor < currentWeek; cursor = addDays(cursor, 7)) weeks.push({ weekStart: cursor, closed: 0, closedByDomain: {}, closedBySize: {}, closedUnitsByDomain: {} });
    const byWeek = new Map(weeks.map(item => [item.weekStart, item]));
    for (const action of actions.filter(item => item.attributes.status === 'closed')) {
      const closedAt = latestTransition(action.attributes, 'closed');
      const date = closedAt ? localDate(closedAt, normalizedCalendar.timezone) : null;
      if (!date) { issues.push(issue('ACTION_CLOSURE_TIME_MISSING', action.path, `Closed Action ${action.id} has no valid close time`, [action.id])); continue; }
      const item = byWeek.get(weekStart(date));
      if (!item) continue;
      item.closed += 1;
      item.closedByDomain[action.attributes.domain] = (item.closedByDomain[action.attributes.domain] ?? 0) + 1;
      item.closedBySize[action.attributes.size] = (item.closedBySize[action.attributes.size] ?? 0) + 1;
      item.closedUnitsByDomain[action.attributes.domain] = (item.closedUnitsByDomain[action.attributes.domain] ?? 0) + SIZE_WEIGHTS[action.attributes.size];
    }
    for (const item of weeks) for (const field of ['closedByDomain', 'closedBySize', 'closedUnitsByDomain']) item[field] = Object.fromEntries(Object.entries(item[field]).sort());

    const reopenTransitions = actions.flatMap(action => action.attributes.status_history
      .filter(entry => entry?.from === 'closed' && entry?.to === 'reopened')
      .map(entry => ({ actionId: action.id, path: action.path, at: entry.at, reason: entry.reason ?? null })));
    reopenTransitions.sort((left, right) => left.at.localeCompare(right.at, 'en') || left.actionId.localeCompare(right.actionId, 'en'));
    const everClosed = actions.filter(action => action.attributes.status_history.some(entry => entry?.to === 'closed')).length;
    const scopeAdded = remaining.filter(action => {
      const date = localDate(action.attributes.created, normalizedCalendar.timezone);
      return date && date >= currentWeek && date <= normalizedCalendar.asOf;
    }).map(action => ({ actionId: action.id, path: action.path, created: action.attributes.created }));
    const handoff = summarizeHandoffs(records, normalizedCalendar, issues);
    return deepFreeze({
      total: actions.length, remaining: remaining.length,
      remainingItems: remaining.map(action => ({ actionId: action.id, path: action.path, status: action.attributes.status, domain: action.attributes.domain, size: action.attributes.size, nextStep: action.attributes.next_step })),
      byDomain: countBy(remaining, 'domain'), bySize: countBy(remaining, 'size'), inProgress: actions.filter(action => IN_PROGRESS.has(action.attributes.status)).length,
      blockers, blockerHistory,
      reopened: { transitions: reopenTransitions.length, current: actions.filter(action => action.attributes.status === 'reopened').length, rate: everClosed === 0 ? 0 : reopenTransitions.length / everClosed, items: reopenTransitions },
      scopeAdded, throughputHistory: { completeWeeks: weeks.length, weeks }, futureCapacity: normalizedCalendar.weeks.filter(item => item.weekStart >= currentWeek), handoff,
      issues: sortIssues(issues)
    });
  } catch (error) {
    if (error instanceof ResearchOSError) throw error;
    throw validation(`Cannot summarize Actions: ${error.message}`);
  }
}

function validateDependencyTarget(record) {
  if (!isCanonicalRecordLocation(record)) return 'DEPENDENCY_NONCANONICAL';
  const schema = schemaForRecordType(record.type);
  if (!schema || validateRecord(schema, record.attributes).length > 0) return 'DEPENDENCY_SCHEMA_INVALID';
  if (validateStatusHistory(record.attributes, record.path).length > 0) return 'DEPENDENCY_HISTORY_INVALID';
  return null;
}

function dependencyState(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  const actions = records.filter(record => record.type === 'action');
  const remaining = actions.filter(action => isScheduledActionStatus(action.attributes.status));
  const problems = [];
  const graph = new Map();
  for (const action of remaining) {
    const unresolvedActions = [];
    for (const dependency of new Set(action.attributes.dependencies)) {
      const target = byId.get(dependency);
      if (!target) { problems.push({ code: 'DEPENDENCY_MISSING', action, dependency, message: `Action ${action.id} depends on missing record ${dependency}` }); continue; }
      if (!DEPENDENCY_TYPES.has(target.type)) { problems.push({ code: 'DEPENDENCY_WRONG_TYPE', action, dependency, target, message: `Action ${action.id} dependency ${dependency} has unsupported type ${target.type}` }); continue; }
      const invalid = validateDependencyTarget(target);
      if (invalid) { problems.push({ code: invalid, action, dependency, target, message: `Action ${action.id} dependency ${dependency} has invalid canonical authority` }); continue; }
      if (target.attributes.status !== 'closed') {
        if (target.type === 'action' && isScheduledActionStatus(target.attributes.status)) unresolvedActions.push(target.id);
        else problems.push({ code: 'DEPENDENCY_UNRESOLVED', action, dependency, target, message: `Action ${action.id} dependency ${dependency} is ${target.attributes.status}, not closed` });
      }
    }
    graph.set(action.id, unresolvedActions);
  }
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(id, stack) {
    if (visiting.has(id)) { const start = stack.indexOf(id); cycles.push([...stack.slice(start), id]); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next, [...stack, id]);
    visiting.delete(id); visited.add(id);
  }
  for (const id of [...graph.keys()].sort()) visit(id, []);
  let chain = [];
  if (cycles.length === 0) {
    const memo = new Map();
    const longestTo = id => {
      if (memo.has(id)) return memo.get(id);
      let longest = [];
      for (const dependency of graph.get(id) ?? []) {
        const candidate = longestTo(dependency);
        if (candidate.length > longest.length || (candidate.length === longest.length && candidate.join('\0').localeCompare(longest.join('\0'), 'en') < 0)) longest = candidate;
      }
      const value = [...longest, id]; memo.set(id, value); return value;
    };
    for (const id of [...graph.keys()].sort()) { const candidate = longestTo(id); if (candidate.length > chain.length) chain = candidate; }
  }
  return { problems, cycles, chain, byId };
}

function capacityFor(calendar, start) { return calendar.weeks.find(item => item.weekStart === start)?.availableUnits ?? calendar.defaultWeeklyUnits; }

function currentCapacity(records, calendar) {
  const start = weekStart(calendar.asOf);
  const wholeWeekUnits = capacityFor(calendar, start);
  let currentWeekClosedUnits = 0;
  for (const action of records.filter(record => record.type === 'action' && record.attributes.status === 'closed')) {
    const at = latestTransition(action.attributes, 'closed');
    const date = at && localDate(at, calendar.timezone);
    if (date && date >= start && date <= calendar.asOf) currentWeekClosedUnits += SIZE_WEIGHTS[action.attributes.size];
  }
  const remainingCalendarDaysIncludingAsOf = daysBetween(calendar.asOf, addDays(start, 6)) + 1;
  const currentRemaining = Math.max(0, Math.min(
    wholeWeekUnits - currentWeekClosedUnits,
    wholeWeekUnits * remainingCalendarDaysIncludingAsOf / 7
  ));
  return { start, wholeWeekUnits, currentWeekClosedUnits, remainingCalendarDaysIncludingAsOf, currentRemaining };
}

function completionDate(units, calendar, current) {
  if (units <= 0) return calendar.asOf;
  let remaining = units;
  if (current.currentRemaining > 0 && remaining <= current.currentRemaining) {
    const offset = Math.max(0, Math.ceil((remaining / current.currentRemaining) * current.remainingCalendarDaysIncludingAsOf) - 1);
    return addDays(calendar.asOf, Math.min(offset, current.remainingCalendarDaysIncludingAsOf - 1));
  }
  remaining -= current.currentRemaining;
  let cursor = addDays(current.start, 7);
  for (let guard = 0; guard < 520; guard += 1) {
    const capacity = capacityFor(calendar, cursor);
    if (capacity > 0 && remaining <= capacity) return addDays(cursor, Math.min(Math.max(0, Math.ceil((remaining / capacity) * 7) - 1), 6));
    remaining -= capacity;
    cursor = addDays(cursor, 7);
  }
  return null;
}

function completionRange(units, calendar, current, lowerFactor, upperFactor) {
  return { earliest: completionDate(units * lowerFactor, calendar, current), latest: completionDate(units * upperFactor, calendar, current) };
}

function finiteCounts(value, label, allowedKeys, integers = false) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw validation(`${label} must be an object`);
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.includes(key)) throw validation(`${label} contains unsupported key ${key}`);
    if (!Number.isFinite(count) || count < 0 || (integers && !Number.isInteger(count))) throw validation(`${label} values must be ${integers ? 'integers, ' : ''}finite and non-negative`);
  }
}

function attainableDomainUnits(closureCount, units) {
  if (closureCount === 0) return units === 0;
  // For n weights chosen from {1,2,4}, every integer in [n,4n] is reachable
  // except 4n-1 (equivalently n + x + 3y with x+y <= n).
  return units >= closureCount && units <= 4 * closureCount && units !== 4 * closureCount - 1;
}

function normalizedHistory(value, calendar) {
  const history = safeDataClone(value ?? { completeWeeks: 0, weeks: [] }, 'throughputHistory');
  if (!history || !Number.isInteger(history.completeWeeks) || history.completeWeeks < 0 || !Array.isArray(history.weeks)) throw validation('throughputHistory must declare non-negative completeWeeks and weeks');
  if (Object.keys(history).sort().join(',') !== 'completeWeeks,weeks') throw validation('throughputHistory fields must be exactly completeWeeks and weeks');
  if (history.completeWeeks !== history.weeks.length) throw validation('throughputHistory completeWeeks must equal weeks.length');
  let previous = null;
  const currentWeek = weekStart(calendar.asOf);
  for (const [index, week] of history.weeks.entries()) {
    if (!week || Array.isArray(week) || typeof week !== 'object' || !isValidDate(week.weekStart) || weekStart(week.weekStart) !== week.weekStart) throw validation(`throughputHistory week ${index} is invalid`);
    if (Object.keys(week).sort().join(',') !== 'closed,closedByDomain,closedBySize,closedUnitsByDomain,weekStart') throw validation(`throughputHistory week ${index} fields are not exact`);
    if (previous !== null && addDays(previous, 7) !== week.weekStart) throw validation('throughputHistory weeks must be unique, contiguous seven-day periods');
    if (week.weekStart >= currentWeek) throw validation('throughputHistory may contain only complete weeks before the current week');
    if (!Number.isInteger(week.closed) || week.closed < 0) throw validation(`throughputHistory week ${index}.closed must be a non-negative integer`);
    finiteCounts(week.closedByDomain, `throughputHistory week ${index}.closedByDomain`, ACTION_DOMAINS, true);
    finiteCounts(week.closedBySize, `throughputHistory week ${index}.closedBySize`, ACTION_SIZES, true);
    finiteCounts(week.closedUnitsByDomain, `throughputHistory week ${index}.closedUnitsByDomain`, ACTION_DOMAINS, true);
    if (Object.values(week.closedByDomain).reduce((sum, count) => sum + count, 0) !== week.closed) throw validation(`throughputHistory week ${index}.closedByDomain must sum to closed`);
    if (Object.values(week.closedBySize).reduce((sum, count) => sum + count, 0) !== week.closed) throw validation(`throughputHistory week ${index}.closedBySize must sum to closed`);
    const sizeUnits = Object.entries(week.closedBySize).reduce((sum, [size, count]) => sum + SIZE_WEIGHTS[size] * count, 0);
    const domainUnits = Object.values(week.closedUnitsByDomain).reduce((sum, count) => sum + count, 0);
    if (sizeUnits !== domainUnits) throw validation(`throughputHistory week ${index} size units must equal domain units`);
    for (const domain of ACTION_DOMAINS) {
      const closureCount = week.closedByDomain[domain] ?? 0;
      const units = week.closedUnitsByDomain[domain] ?? 0;
      if (!attainableDomainUnits(closureCount, units)) throw validation(`throughputHistory week ${index}.${domain} units are not attainable from its closure count`);
    }
    previous = week.weekStart;
  }
  if (history.weeks.length > 0 && history.weeks.at(-1).weekStart !== addDays(currentWeek, -7)) throw validation('throughputHistory must end with the immediately preceding complete week');
  return history;
}

function confidenceActions({ issues, history, sentinels, riskCount, fallbackGroups, horizon }) {
  const actions = [];
  const codes = new Set(issues.map(item => item.code));
  if ([...codes].some(code => code.startsWith('DEPENDENCY_'))) actions.push('Resolve and close every dependency authority before relying on dates.');
  if (codes.has('FORECAST_AS_OF_BEFORE_AUTHORITY')) actions.push('Advance asOf or remove future lifecycle authority before recalculating.');
  if (sentinels > 0) actions.push('classify Action domains and estimate Action sizes.');
  if (history.completeWeeks < 3) actions.push('Record at least three complete throughput weeks, including zero-closure weeks.');
  if (fallbackGroups > 0) actions.push('Collect closure history for domains currently using scenario fallback.');
  if (riskCount > 0) actions.push('Close active blockers or quantify remaining risk before narrowing the range.');
  if (horizon) actions.push('Add usable capacity within the 520-week forecast horizon.');
  return [...new Set(actions)];
}

/** Produce deterministic three-range completion scenarios from canonical Action units. */
export function forecastCompletion(input) {
  try {
    const top = safeOwnDataProperties(
      input,
      ['actions', 'throughputHistory', 'capacityCalendar'],
      'forecast input',
      ['actions', 'throughputHistory', 'capacityCalendar', 'integrationBuffer']
    );
    const records = recordsFromCatalog(top.actions);
    const actions = records.filter(record => record.type === 'action');
    const remaining = actions.filter(action => isScheduledActionStatus(action.attributes.status));
    const calendar = normalizeCalendar(top.capacityCalendar);
    const history = normalizedHistory(top.throughputHistory, calendar);
    const integrationBuffer = top.integrationBuffer ?? 0.2;
    if (!Number.isFinite(integrationBuffer) || integrationBuffer < 0 || integrationBuffer > 1) throw validation('integrationBuffer must be finite and between 0 and 1');
    const assumptions = [];
    const changeReasons = ['No canonical previous forecast baseline; this is the initial forecast.'];
    const issues = authorityCutoffIssues(records, calendar);
    const dependencies = dependencyState(records);
    for (const problem of dependencies.problems) issues.push(issue(problem.code, problem.action.path, problem.message, [problem.action.id, problem.dependency]));
    for (const cycle of dependencies.cycles) {
      for (const id of [...new Set(cycle)]) issues.push(issue('DEPENDENCY_CYCLE', dependencies.byId.get(id)?.path ?? 'plans/actions', `Action dependency cycle: ${cycle.join(' -> ')}`, cycle));
    }
    const criticalDependencies = [
      ...dependencies.problems.map(item => ({ type: item.code.toLowerCase(), actionId: item.action.id, dependency: item.dependency, path: item.action.path, targetPath: item.target?.path ?? null })),
      ...dependencies.cycles.map(cycle => ({ type: 'cycle', actions: cycle, paths: [...new Set(cycle)].map(id => dependencies.byId.get(id)?.path).filter(Boolean) })),
      ...(dependencies.chain.length > 1 ? [{ type: 'chain', actions: dependencies.chain, paths: dependencies.chain.map(id => dependencies.byId.get(id).path) }] : [])
    ];
    const currentWeek = weekStart(calendar.asOf);
    const scopeAdded = remaining.filter(action => { const date = localDate(action.attributes.created, calendar.timezone); return date && date >= currentWeek && date <= calendar.asOf; }).length;
    const reopenTransitions = actions.reduce((sum, action) => sum + action.attributes.status_history.filter(entry => entry?.from === 'closed' && entry?.to === 'reopened').length, 0);
    if (scopeAdded > 0) changeReasons.push(`${scopeAdded} current-week scope additions affect remaining work.`);
    if (reopenTransitions > 0) changeReasons.push(`${reopenTransitions} recorded reopen transitions widen or reset completion work.`);
    for (const action of remaining) {
      if (action.attributes.domain === 'unclassified') issues.push(issue('ACTION_DOMAIN_UNCLASSIFIED', action.path, 'Action domain is not classified', [action.id]));
      if (action.attributes.size === 'unestimated') issues.push(issue('ACTION_SIZE_UNESTIMATED', action.path, 'Action size is not estimated; median fallback weight 2 is used', [action.id]));
    }
    const cutoff = issues.some(item => item.code === 'FORECAST_AS_OF_BEFORE_AUTHORITY');
    const dependencyBlocked = dependencies.problems.length > 0 || dependencies.cycles.length > 0;
    const method = history.completeWeeks >= 3 ? 'observed' : 'scenario';
    if (remaining.length === 0 && !cutoff) {
      const complete = { earliest: calendar.asOf, latest: calendar.asOf };
      assumptions.push('No scheduled Actions remain at the canonical asOf date; deferred and retired work is excluded.');
      return deepFreeze({ method, optimistic: complete, median: complete, conservative: complete, confidence: 'high', confidenceActions: [], assumptions, changeReasons, criticalDependencies, issues: sortIssues(issues) });
    }
    if (cutoff || dependencyBlocked) {
      assumptions.push('Completion dates are withheld until lifecycle and dependency authority is valid at asOf.');
      const withheld = { earliest: null, latest: null };
      const sentinels = remaining.filter(action => action.attributes.domain === 'unclassified' || action.attributes.size === 'unestimated').length;
      const actionsToImprove = confidenceActions({ issues, history, sentinels, riskCount: 0, fallbackGroups: 0, horizon: false });
      return deepFreeze({ method, optimistic: withheld, median: withheld, conservative: withheld, confidence: 'low', confidenceActions: actionsToImprove, assumptions, changeReasons, criticalDependencies, issues: sortIssues(issues) });
    }

    let units = remaining.reduce((sum, action) => sum + SIZE_WEIGHTS[action.attributes.size], 0);
    const riskCount = remaining.reduce((sum, action) => sum + action.attributes.risks.length + action.attributes.blockers.filter(blocker => blocker.status === 'active').length, 0);
    const sentinels = remaining.filter(action => action.attributes.domain === 'unclassified' || action.attributes.size === 'unestimated').length;
    if (method === 'scenario') {
      assumptions.push('Early scenario forecast: no claim of observed personal throughput.');
      assumptions.push('Optimistic assumes one-pass protocol, stable scope, and declared capacity.');
      assumptions.push('Median includes a routine rerun or narrative revision plus the integration buffer.');
      assumptions.push('Conservative includes rerun, Claim adjustment, risk inflation, and integration buffer.');
    } else {
      assumptions.push(`Observed calibration uses ${history.completeWeeks} complete weeks, including zero-closure weeks.`);
      let estimatedWeeks = 0;
      for (const domain of [...new Set(remaining.map(action => action.attributes.domain))].sort()) {
        const domainUnits = remaining.filter(action => action.attributes.domain === domain).reduce((sum, action) => sum + SIZE_WEIGHTS[action.attributes.size], 0);
        const closedUnits = history.weeks.reduce((sum, week) => sum + (week.closedUnitsByDomain?.[domain] ?? 0), 0);
        const rate = closedUnits / history.completeWeeks;
        if (rate > 0) { estimatedWeeks += domainUnits / rate; assumptions.push(`${domain} uses observed closure velocity ${rate.toFixed(2)} Action units/week.`); }
        else { estimatedWeeks += domainUnits / calendar.defaultWeeklyUnits; assumptions.push(`${domain} has no observed closure velocity; scenario fallback uses declared capacity.`); }
      }
      units = estimatedWeeks * calendar.defaultWeeklyUnits;
    }
    const current = currentCapacity(records, calendar);
    assumptions.push(`Current-week capacity uses currentRemaining=max(0,min(wholeWeekUnits-currentWeekClosedUnits,wholeWeekUnits*remainingCalendarDaysIncludingAsOf/7)); elapsed calendar days are unavailable (${current.currentRemaining.toFixed(2)} units remain).`);
    if (calendar.weeks.some(item => item.availableUnits !== calendar.defaultWeeklyUnits)) changeReasons.push('Declared capacity overrides change the available Action units in specific weeks.');
    if (riskCount > 0) changeReasons.push(`${riskCount} recorded risk or active blocker entries widen the forecast.`);
    if (sentinels > 0) changeReasons.push(`${sentinels} remaining Actions have unclassified domain or unestimated size.`);
    const buffered = units * (1 + integrationBuffer);
    const riskInflation = 1 + Math.min(0.75, riskCount * 0.1);
    const optimistic = completionRange(units, calendar, current, 0.8, 1);
    const median = completionRange(buffered, calendar, current, 1.05, 1.3);
    const conservative = completionRange(buffered * riskInflation, calendar, current, 1.55, 2.15);
    const horizon = [optimistic, median, conservative].some(range => range.earliest === null || range.latest === null);
    if (horizon) issues.push(issue('FORECAST_HORIZON_EXCEEDED', 'PROJECT.md', 'Usable capacity is insufficient within the 520-week forecast horizon'));
    const fallbackGroups = assumptions.filter(item => item.includes('scenario fallback')).length;
    let confidence = sentinels > 0 || riskCount > 2 || fallbackGroups > 1 ? 'low' : riskCount > 0 || fallbackGroups > 0 || history.completeWeeks < 3 ? 'medium' : 'high';
    if (horizon) confidence = 'low';
    const actionsToImprove = confidenceActions({ issues, history, sentinels, riskCount, fallbackGroups, horizon });
    return deepFreeze({ method, optimistic, median, conservative, confidence, confidenceActions: actionsToImprove, assumptions, changeReasons, criticalDependencies, issues: sortIssues(issues) });
  } catch (error) {
    if (error instanceof ResearchOSError) throw error;
    throw validation(`Cannot calculate forecast: ${error.message}`);
  }
}
