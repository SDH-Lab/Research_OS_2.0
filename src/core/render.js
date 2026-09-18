import { ResearchOSError } from '../lib/errors.js';

const TOKEN = /{{([A-Z][A-Z0-9_]*)}}/g;

export function renderTemplate(text, values) {
  const rendered = text.replace(TOKEN, (token, name) => {
    if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) return token;
    return String(values[name]);
  });
  const unresolved = rendered.match(TOKEN);
  if (unresolved) throw new ResearchOSError('CORE_TEMPLATE_TOKEN', `Unresolved template token(s): ${[...new Set(unresolved)].join(', ')}`);
  return rendered;
}
