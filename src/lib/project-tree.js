export const PROJECT_INTERNAL_DIRECTORIES = Object.freeze([
  '.agents', '.codex', '.git', '.obsidian', '.superpowers', '.tmp', 'generated', 'node_modules'
]);

const PROJECT_INTERNAL_DIRECTORY_SET = new Set(PROJECT_INTERNAL_DIRECTORIES);

/** Return whether a directory contains tool state or derived output, not project authority. */
export function isProjectInternalDirectory(name) {
  return PROJECT_INTERNAL_DIRECTORY_SET.has(name);
}
