import { findWriterConflicts, isWriteScopeContained, normalizeProjectRelative, normalizeWritePattern } from './write-scope.js';

const ACTIVE_REGISTRATION_STATUSES = new Set(['registered', 'running', 'blocked', 'candidate_ready']);
const CANONICAL_ID = /^[A-Z]+-[0-9]{3,}$/u;

function issue(code, path, message, relatedIds) {
  return { code, path, message, ...(relatedIds === undefined ? {} : { relatedIds }) };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactSingleLine(value, { nonempty = true } = {}) {
  return typeof value === 'string' && (!nonempty || value.trim().length > 0) && !/[\0\r\n\u2028\u2029]/u.test(value);
}

function validatePatternList(values, path, issues) {
  if (!Array.isArray(values)) return false;
  let valid = true;
  for (const [index, value] of values.entries()) {
    try {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Write-scope pattern must be a meaningful string: ${String(value)}`);
      normalizeWritePattern(value);
    } catch (error) {
      valid = false;
      issues.push(issue('EXEC_PLAN_PATH_INVALID', `${path}/${index}`, error.message));
    }
  }
  return valid;
}

function validateExactPathList(values, path, issues) {
  if (!Array.isArray(values)) return false;
  let valid = true;
  for (const [index, value] of values.entries()) {
    try {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Exact path must be a meaningful string: ${String(value)}`);
      const normalized = normalizeProjectRelative(value);
      if (normalized.includes('*')) throw new Error(`Exact path cannot contain a wildcard: ${value}`);
    } catch (error) {
      valid = false;
      issues.push(issue('EXEC_PLAN_PATH_INVALID', `${path}/${index}`, error.message));
    }
  }
  return valid;
}

function validateExactField(value, path, issues, options = {}) {
  if (exactSingleLine(value, options)) return true;
  const qualifier = options.nonempty === false ? 'single-line string' : 'meaningful non-empty single-line string';
  issues.push(issue('EXEC_PLAN_FIELD_INVALID', path, `Field must be a ${qualifier}`));
  return false;
}

function validateMeaningfulStringArray(values, path, issues, code) {
  if (!Array.isArray(values)) return false;
  let valid = true;
  for (const [index, value] of values.entries()) {
    if (exactSingleLine(value)) continue;
    valid = false;
    issues.push(issue(code, `${path}/${index}`, 'Entry must be a meaningful non-empty single-line string'));
  }
  return valid;
}

function validateRecoveryPacket(packet, path, issues) {
  if (!isRecord(packet)) {
    issues.push(issue('RECOVERY_PACKET_INVALID', path, 'Recovery packet must be an object'));
    return false;
  }
  let valid = true;
  valid = validateExactField(packet.last_verified_point, `${path}/last_verified_point`, issues) && valid;
  valid = validateExactField(packet.next_action, `${path}/next_action`, issues) && valid;
  if (packet.next_command_or_edit !== null) valid = validateExactField(packet.next_command_or_edit, `${path}/next_command_or_edit`, issues, { nonempty: false }) && valid;
  valid = validateExactPathList(packet.required_files, `${path}/required_files`, issues) && valid;
  valid = validateMeaningfulStringArray(packet.risks, `${path}/risks`, issues, 'RECOVERY_RISK_INVALID') && valid;
  if (packet.reforecast_trigger !== null) valid = validateExactField(packet.reforecast_trigger, `${path}/reforecast_trigger`, issues, { nonempty: false }) && valid;
  return valid;
}

function validatePausedActions(values, path, issues) {
  if (!Array.isArray(values)) return false;
  let valid = true;
  for (const [index, value] of values.entries()) {
    if (typeof value === 'string' && CANONICAL_ID.test(value)) continue;
    valid = false;
    issues.push(issue('DISRUPTION_PAUSED_ACTION_INVALID', `${path}/${index}`, 'Paused Action must be a flat canonical ID'));
  }
  return valid;
}

function duplicateIssues(registrations, field, code, planPath) {
  const byValue = new Map();
  for (const [index, registration] of registrations.entries()) {
    const value = isRecord(registration) ? registration[field] : undefined;
    if (typeof value !== 'string') continue;
    const indexes = byValue.get(value) ?? [];
    indexes.push(index);
    byValue.set(value, indexes);
  }

  const issues = [];
  for (const [value, indexes] of byValue) {
    if (indexes.length < 2) continue;
    for (const index of indexes) issues.push(issue(code, `${planPath}#/background_register/${index}/${field}`, `Background ${field} must be globally unique: ${value}`));
  }
  return issues;
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function exactControlPaths(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((path, index) => path === expected[index]);
}

/**
 * Validate semantic authority invariants not expressible in the ExecPlan JSON Schema.
 * The function is total over arbitrary parsed values and never assumes schema validity.
 * @param {unknown} plan
 * @param {string} planPath
 * @param {unknown} [project]
 * @returns {ReadonlyArray<Readonly<{code: string, path: string, message: string}>>}
 */
export function validateExecPlanControls(plan, planPath, project = null) {
  const issues = [];
  if (!isRecord(plan)) {
    return Object.freeze([Object.freeze(issue('EXEC_PLAN_CONTROL_INVALID', planPath, 'ExecPlan control plane must be an object'))]);
  }
  const controlPaths = ['PROJECT.md', planPath];
  const planWritableValid = validatePatternList(plan.writable_paths, `${planPath}#/writable_paths`, issues);
  validateMeaningfulStringArray(plan.blockers, `${planPath}#/blockers`, issues, 'EXEC_PLAN_BLOCKER_INVALID');
  const resumeValid = validateRecoveryPacket(plan.resume_point, `${planPath}#/resume_point`, issues);

  if (plan.disruption_mode !== null) {
    const disruptionPath = `${planPath}#/disruption_mode`;
    if (!isRecord(plan.disruption_mode)) {
      issues.push(issue('DISRUPTION_MODE_INVALID', disruptionPath, 'disruption_mode must be null or an object'));
    } else {
      validateExactField(plan.disruption_mode.capacity_reduction, `${disruptionPath}/capacity_reduction`, issues);
      validatePausedActions(plan.disruption_mode.paused_actions, `${disruptionPath}/paused_actions`, issues);
      validateRecoveryPacket(plan.disruption_mode, disruptionPath, issues);
    }
  }


  let registrations = [];
  if (Array.isArray(plan.background_register)) registrations = plan.background_register;
  else issues.push(issue('BACKGROUND_REGISTER_INVALID', `${planPath}#/background_register`, 'background_register must be an array'));
  issues.push(...duplicateIssues(registrations, 'id', 'DUPLICATE_BACKGROUND_ID', planPath));
  issues.push(...duplicateIssues(registrations, 'task_id', 'DUPLICATE_BACKGROUND_TASK_ID', planPath));
  for (const [index, registration] of registrations.entries()) {
    const base = `${planPath}#/background_register/${index}`;
    if (!isRecord(registration)) {
      issues.push(issue('BACKGROUND_REGISTRATION_INVALID', base, 'Background registration must be an object'));
      continue;
    }
    validatePatternList(registration.readable_paths, `${base}/readable_paths`, issues);
    const writableValid = validatePatternList(registration.writable_paths, `${base}/writable_paths`, issues);
    const artifactsValid = validateExactPathList(registration.expected_artifacts, `${base}/expected_artifacts`, issues);
    validateExactPathList(registration.control_paths, `${base}/control_paths`, issues);
    validateMeaningfulStringArray(registration.forbidden_changes, `${base}/forbidden_changes`, issues, 'BACKGROUND_AUTHORITY_FIELD_INVALID');
    validateMeaningfulStringArray(registration.blockers, `${base}/blockers`, issues, 'BACKGROUND_BLOCKER_INVALID');
    for (const field of ['purpose', 'action_id', 'acceptance', 'owner', 'receiver', 'task_id']) {
      validateExactField(registration[field], `${base}/${field}`, issues);
    }
    if (!exactControlPaths(registration.control_paths, controlPaths)) {
      issues.push(issue('BACKGROUND_CONTROL_PATH_INVALID', `${base}/control_paths`, `control_paths must be exactly PROJECT.md and ${planPath}`));
    }
    const hasMeaningfulBlocker = Array.isArray(registration.blockers) && registration.blockers.some(blocker => exactSingleLine(blocker));
    if (registration.status === 'blocked' && !hasMeaningfulBlocker) {
      issues.push(issue('BLOCKED_WITHOUT_BLOCKER', `${base}/blockers`, 'Blocked background work must record at least one meaningful blocker'));
    }
    const planCreated = timestamp(plan.created);
    const registeredAt = timestamp(registration.registered_at);
    const updatedAt = timestamp(registration.updated_at);
    const planUpdated = timestamp(plan.updated);
    if (![planCreated, registeredAt, updatedAt, planUpdated].every(Number.isFinite) || planCreated > registeredAt || registeredAt > updatedAt || updatedAt > planUpdated) {
      issues.push(issue('BACKGROUND_TIMESTAMP_INVALID', `${base}/updated_at`, 'Background timestamps must satisfy plan.created <= registered_at <= updated_at <= plan.updated'));
    }
    if (writableValid && artifactsValid && !isWriteScopeContained(registration.writable_paths, registration.expected_artifacts, controlPaths)) {
      issues.push(issue('BACKGROUND_ARTIFACT_OUT_OF_SCOPE', `${base}/expected_artifacts`, 'Every expected Artifact must be inside the registered writable scope'));
    }
    if (ACTIVE_REGISTRATION_STATUSES.has(registration.status) && planWritableValid && writableValid && !isWriteScopeContained(plan.writable_paths, registration.writable_paths, controlPaths)) {
      issues.push(issue('WRITE_SCOPE_NOT_IN_ACTIVE_PLAN', `${base}/writable_paths`, 'Active background scope must be contained in Active Plan writable_paths'));
    }
  }

  for (const [index, registration] of registrations.entries()) {
    if (!isRecord(registration) || !ACTIVE_REGISTRATION_STATUSES.has(registration.status) || !Array.isArray(registration.writable_paths)) continue;
    const later = registrations.slice(index + 1).filter(item => isRecord(item) && ACTIVE_REGISTRATION_STATUSES.has(item.status));
    let conflicts = [];
    try { conflicts = findWriterConflicts(later, registration.writable_paths); } catch { continue; }
    for (const conflict of conflicts) {
      const otherIndex = registrations.findIndex(item => isRecord(item) && item.id === conflict.id);
      const ids = [String(registration.id), conflict.id].sort((left, right) => left.localeCompare(right, 'en'));
      const scopes = [...new Set([...registration.writable_paths, ...conflict.writablePaths])].sort((left, right) => left.localeCompare(right, 'en'));
      const message = `Active background writers ${ids.join(' and ')} have overlapping scopes: ${scopes.join(', ')}`;
      issues.push(issue('BACKGROUND_WRITER_CONFLICT', `${planPath}#/background_register/${index}/writable_paths`, message, ids));
      issues.push(issue('BACKGROUND_WRITER_CONFLICT', `${planPath}#/background_register/${otherIndex}/writable_paths`, message, ids));
    }
  }

  return Object.freeze(issues
    .sort((left, right) => left.path.localeCompare(right.path, 'en') || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'en'))
    .map(item => Object.freeze(item)));
}
