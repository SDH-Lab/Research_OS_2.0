import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { walkFiles } from '../lib/fs.js';
import { ResearchOSError } from '../lib/errors.js';

function schemaName(file) {
  return basename(file, '.schema.json');
}

export async function loadCore(coreRoot) {
  const version = await readFile(join(coreRoot, 'VERSION'), 'utf8');
  const files = await walkFiles(coreRoot);
  const schemas = {};
  const templates = { global: {}, project: {}, records: {} };

  for (const file of files) {
    const sourcePath = join(coreRoot, file);
    if (file.startsWith('schemas/') && file.endsWith('.schema.json')) {
      schemas[schemaName(file)] = JSON.parse(await readFile(sourcePath, 'utf8'));
    }
    if (file.startsWith('templates/')) {
      const [, category, ...nameParts] = file.split('/');
      templates[category][nameParts.join('/').replace(/\.md$/, '')] = await readFile(sourcePath, 'utf8');
    }
  }
  if (!version.trim()) throw new ResearchOSError('CORE_VERSION', 'Core VERSION is empty');
  return Object.freeze({
    version: version.trim(),
    schemas: Object.freeze(schemas),
    templates: Object.freeze({ global: Object.freeze(templates.global), project: Object.freeze(templates.project), records: Object.freeze(templates.records) }),
    transitions: Object.freeze(JSON.parse(await readFile(join(coreRoot, 'rules', 'status-transitions.json'), 'utf8')))
  });
}
