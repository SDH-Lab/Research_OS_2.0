import YAML from 'yaml';
import { ResearchOSError } from './errors.js';

function normalizedBody(body) {
  return `${body.replace(/\n+$/, '')}\n`;
}

export function parseMarkdownDocument(text, filePath) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new ResearchOSError('FRONTMATTER_BOUNDARY', `Invalid frontmatter: ${filePath}`);
  const document = YAML.parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new ResearchOSError('FRONTMATTER_YAML', document.errors[0].message);
  const attributes = document.toJS();
  if (!attributes || Array.isArray(attributes) || typeof attributes !== 'object') {
    throw new ResearchOSError('FRONTMATTER_OBJECT', `Frontmatter must be an object: ${filePath}`);
  }
  return Object.freeze({ attributes: Object.freeze(attributes), body: normalizedBody(match[2]) });
}

export function serializeMarkdownDocument(attributes, body) {
  const frontmatter = YAML.stringify(attributes, { lineWidth: 0, sortMapEntries: true }).trimEnd();
  return `---\n${frontmatter}\n---\n${normalizedBody(body)}`;
}
