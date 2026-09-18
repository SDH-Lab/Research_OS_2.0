import { parseMarkdownDocument } from '../lib/markdown.js';
import { deepFreeze } from '../lib/readonly.js';
import { readUtf8, safeJoin } from '../lib/fs.js';
import { validateProject } from '../validation/validator.js';

const INITIAL_STEP = 'Define the foreground objective.';
const CONFIRMED_STATUSES = new Set(['ready', 'in_progress', 'review', 'verified', 'closed', 'reopened']);

function meaningful(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function gap(id, authority, message, details) {
  return { id, authority, message, ...(details === undefined ? {} : { details }) };
}

function nonemptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(meaningful);
}

function inspectMechanicalGaps(project, plan, planPath) {
  const gaps = [];
  if (!meaningful(project.foreground_objective) || project.foreground_objective === 'Not set') {
    gaps.push(gap('foreground-objective', 'PROJECT.md#/foreground_objective', 'Foreground objective needs a human-approved value.'));
  }
  if (!nonemptyStrings(plan.completion_conditions)) {
    gaps.push(gap('completion-conditions', `${planPath}#/completion_conditions`, 'Completion conditions need at least one human-approved criterion.'));
  }
  if (!nonemptyStrings(plan.scope)) {
    gaps.push(gap('scope', `${planPath}#/scope`, 'Scope needs at least one human-approved boundary.'));
  }
  const resumeNext = plan.resume_point?.next_action;
  if (!meaningful(resumeNext) || resumeNext === INITIAL_STEP) {
    gaps.push(gap('resume-next-action', `${planPath}#/resume_point/next_action`, 'Choose the next concrete action.'));
  }
  if (!CONFIRMED_STATUSES.has(project.status)) {
    gaps.push(gap('project-status', 'PROJECT.md#/status', 'Project setup has not been recorded as human-reviewed.'));
  }
  if (!CONFIRMED_STATUSES.has(plan.status)) {
    gaps.push(gap('active-plan-status', `${planPath}#/status`, 'Active Plan setup has not been recorded as human-reviewed.'));
  }
  return gaps;
}

function observation(count, noun) {
  return count === 0
    ? `No ${noun} recorded; empty may be legitimate only after human review.`
    : `${count} ${noun} recorded; confirm meaning and access with the human.`;
}

function setupReviewItems(project, plan, planPath) {
  const confirmed = CONFIRMED_STATUSES.has(project.status) && CONFIRMED_STATUSES.has(plan.status);
  const status = confirmed ? 'confirmed' : 'review-required';
  return [
    { id: 'writable-paths', status, authority: `${planPath}#/writable_paths`, observation: observation(plan.writable_paths?.length ?? 0, 'writable path(s)') },
    { id: 'timezone-and-capacity', status, authority: 'PROJECT.md#/forecast_settings', observation: `Timezone=${project.forecast_settings?.timezone ?? 'unknown'}; weekly capacity=${project.forecast_settings?.default_weekly_capacity ?? 'unknown'}.` },
    { id: 'resources-and-access', status, authority: 'PROJECT.md#/resources', observation: observation(Object.keys(project.resources ?? {}).length, 'resource(s)') },
    { id: 'modules', status, authority: 'PROJECT.md#/modules', observation: observation(project.modules?.length ?? 0, 'module(s)') },
    { id: 'approved-code-roots', status, authority: 'PROJECT.md#/approved_code_roots', observation: observation(project.approved_code_roots?.length ?? 0, 'approved code root(s)') },
    { id: 'canonical-writing-sources', status, authority: 'PROJECT.md#/canonical_writing_sources', observation: observation(Object.keys(project.canonical_writing_sources ?? {}).length, 'canonical writing source(s)') }
  ];
}

function setupNextAction(missingAuthority) {
  if (missingAuthority.some(item => item.id === 'project-validation')) {
    return 'Repair the reported project validation errors before setup review.';
  }
  if (missingAuthority.some(item => !['project-status', 'active-plan-status'].includes(item.id))) {
    return 'Prepare a cited setup proposal and request human review.';
  }
  if (missingAuthority.length > 0) {
    return 'Request human approval, then transition the Active Plan and Project to ready.';
  }
  return 'Run session context, read the required authority, and preflight the next Action.';
}

export async function inspectProjectSetup(projectRoot) {
  const validation = await validateProject(projectRoot);
  const projectDocument = parseMarkdownDocument(
    await readUtf8(safeJoin(projectRoot, 'PROJECT.md')),
    'PROJECT.md'
  );
  const planPath = projectDocument.attributes.active_plan;
  const planDocument = parseMarkdownDocument(
    await readUtf8(safeJoin(projectRoot, planPath)),
    planPath
  );
  const missingAuthority = inspectMechanicalGaps(projectDocument.attributes, planDocument.attributes, planPath);
  if (!validation.ok) {
    missingAuthority.unshift(gap(
      'project-validation',
      'PROJECT.md',
      'Project validation must pass before setup can be confirmed.',
      validation.issues
    ));
  }
  return deepFreeze({
    configured: missingAuthority.length === 0,
    missingAuthority,
    humanReview: setupReviewItems(projectDocument.attributes, planDocument.attributes, planPath),
    authoritySources: ['PROJECT.md', planPath],
    nextAction: setupNextAction(missingAuthority)
  });
}
