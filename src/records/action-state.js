const TERMINAL = new Set(['closed', 'cancelled', 'superseded']);
const SCHEDULED = new Set(['inbox', 'defined', 'ready', 'in_progress', 'review', 'verified', 'reopened']);

/** Successful completion remains distinct from a task retired by human decision. */
export function isSuccessfulActionStatus(status) { return status === 'closed'; }
export function isTerminalActionStatus(status) { return TERMINAL.has(status); }
export function isScheduledActionStatus(status) { return SCHEDULED.has(status); }
