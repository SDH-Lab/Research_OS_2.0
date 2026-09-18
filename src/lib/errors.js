export const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE: 2,
  VALIDATION: 3,
  BLOCKED: 4,
  CONFLICT: 5,
  NOT_FOUND: 6,
  IO: 7
});

export class ResearchOSError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ResearchOSError';
    this.code = code;
    this.details = details;
  }
}
