import { pathToFileURL } from 'node:url';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { COMMANDS, parseOptions } from '../src/cli.js';

const REQUIRED = Object.freeze(['README.md', ...Array.from({ length: 13 }, (_, index) => `${String(index + 1).padStart(2, '0')}-${[
  'installation-and-first-project', 'mental-model-and-authority', 'layout-records-and-links', 'daily-weekly-and-disruption',
  'sessions-agents-and-handoffs', 'experiment-workflow', 'writing-and-response', 'validation-and-human-gates',
  'dashboard-and-forecast', 'maintenance-troubleshooting-and-backup', 'core-upgrades-and-migrations', 'cli-and-schema-reference', 'recipes'
][index]}.md`)]);
const MARKER_ALLOWLIST = new Map([
  ['03-layout-records-and-links.md', new Set(['Writing Unit'])],
  ['07-writing-and-response.md', new Set([
    '6. Evidence-to-Writing Packet'
  ])],
  ['13-recipes.md', new Set(['3. 创建 Response Block 与一个双 source Manuscript Change'])]
]);

function docIssue(code, path, message) { return Object.freeze({ code, path, message }); }
function insideRoot(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (!fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}
function markerAllowed(name, heading) {
  return MARKER_ALLOWLIST.get(name)?.has(heading) === true;
}
function registeredCommand(tokens, commands) {
  for (let length = Math.min(3, tokens.length); length > 0; length -= 1) {
    const candidate = tokens.slice(0, length).join(' ');
    if (commands.has(candidate)) return Object.freeze({ path: candidate, length });
  }
  return null;
}
function shellTokens(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };
  for (const character of text.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    if (['>', '<', '|', ';'].includes(character)) {
      push();
      break;
    }
    current += character;
  }
  if (quote !== null) throw new SyntaxError(`Unclosed ${quote} quote`);
  if (escaped) throw new SyntaxError('Dangling escape');
  push();
  return tokens;
}
function logicalLines(content) {
  const result = [];
  let pending = '';
  let startLine = 1;
  for (const [index, rawLine] of content.split('\n').entries()) {
    if (pending === '') startLine = index + 1;
    const continued = /\\\s*$/u.test(rawLine);
    pending += `${pending === '' ? '' : ' '}${rawLine.replace(/\\\s*$/u, '')}`;
    let quote = null;
    let escaped = false;
    for (const character of pending) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote && character === quote) quote = null;
      else if (!quote && (character === "'" || character === '"')) quote = character;
    }
    const inline = /`research-os\b/u.test(pending);
    if (!continued && (inline || quote === null || !/\bresearch-os\b/u.test(pending))) {
      result.push(Object.freeze({ line: startLine, text: pending }));
      pending = '';
    }
  }
  if (pending !== '') result.push(Object.freeze({ line: startLine, text: pending, danglingContinuation: true }));
  return result;
}
function invocationSegments(line) {
  const segments = [];
  const pattern = /\bresearch-os\b/gu;
  for (const match of line.matchAll(pattern)) {
    const start = match.index;
    const inline = start > 0 && line[start - 1] === '`';
    const prefix = line.slice(0, start);
    const presentationPrefix = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\$\s+)?$/u;
    if (!inline && !presentationPrefix.test(prefix)) continue;
    const end = inline ? line.indexOf('`', start) : -1;
    segments.push(line.slice(start, end === -1 ? undefined : end));
  }
  return segments;
}
function referenceRows(content) {
  const rows = [];
  const pattern = /^\| `research-os ([^`]+)` \| (?:`([^`]+)`|无) \| (?:`([^`]+)`|无) \|$/gmu;
  for (const match of content.matchAll(pattern)) {
    rows.push(Object.freeze({
      path: match[1],
      required: match[2] === undefined ? [] : match[2].trim().split(/\s+/u),
      optional: match[3] === undefined ? [] : match[3].trim().split(/\s+/u)
    }));
  }
  return rows;
}
async function validateRelativeLink({ root, sourcePath, target }) {
  let decoded;
  try {
    decoded = decodeURIComponent(target.split('#')[0].split('?')[0]);
  } catch {
    return Object.freeze({ code: 'MALFORMED_RELATIVE_LINK', message: `Malformed link target: ${target}` });
  }
  if (decoded === '') return null;
  const segments = decoded.replace(/\\/gu, '/').split('/');
  const targetPath = resolve(dirname(sourcePath), decoded);
  if (decoded.startsWith('/') || decoded.includes('\\') || segments.includes('..') || !insideRoot(root, targetPath)) {
    return Object.freeze({ code: 'UNSAFE_RELATIVE_LINK', message: `Unsafe link target: ${target}` });
  }
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return Object.freeze({ code: 'BROKEN_RELATIVE_LINK', message: `Missing link target: ${target}` });
    }
    throw error;
  }
  if (targetStat.isSymbolicLink()) {
    return Object.freeze({ code: 'UNSAFE_RELATIVE_LINK', message: `Symlink link target is not allowed: ${target}` });
  }
  if (!targetStat.isFile()) {
    return Object.freeze({ code: 'BROKEN_RELATIVE_LINK', message: `Link target is not a regular file: ${target}` });
  }
  const canonicalTarget = await realpath(targetPath);
  if (!insideRoot(root, canonicalTarget)) {
    return Object.freeze({ code: 'UNSAFE_RELATIVE_LINK', message: `Link target escapes the guide root: ${target}` });
  }
  return null;
}

function walkMarkdown(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}

function normalizedAstIdentifier(label) {
  return label.replace(/[\t\n\r ]+/gu, ' ').replace(/^ | $/gu, '').toLowerCase().toUpperCase().toLowerCase();
}

function markdownAuthorities(content) {
  const tree = fromMarkdown(content);
  const definitions = [];
  const targets = [];
  const textNodes = [];
  const issues = [];
  const firstDefinitions = new Set();
  walkMarkdown(tree, node => {
    if (node.type === 'definition') {
      definitions.push(Object.freeze({ label: node.label ?? node.identifier, target: node.url }));
      if (firstDefinitions.has(node.identifier)) {
        issues.push(Object.freeze({ code: 'DUPLICATE_LINK_DEFINITION', message: `Duplicate reference definition: ${node.label ?? node.identifier}` }));
      } else {
        firstDefinitions.add(node.identifier);
      }
    } else if (node.type === 'link' || node.type === 'image') {
      targets.push(node.url);
    } else if (node.type === 'text') {
      textNodes.push(node.value);
    }
  });

  // Unresolved full/collapsed references are literal text in MDAST. Scan only
  // AST text nodes, so code, HTML, and every other literal context stay out.
  const fullReference = /(?<!!)\[((?:\\[\s\S]|[^\\\]]){1,999})\]\[((?:\\[\s\S]|[^\\\]]){0,999})\]/gu;
  for (const text of textNodes) {
    for (const match of text.matchAll(fullReference)) {
      const rawLabel = match[2] === '' ? match[1] : match[2];
      if (!firstDefinitions.has(normalizedAstIdentifier(rawLabel))) {
        issues.push(Object.freeze({ code: 'BROKEN_REFERENCE_LINK', message: `Missing reference definition: ${rawLabel}` }));
      }
    }
  }
  return Object.freeze({ definitions: Object.freeze(definitions), targets: Object.freeze(targets), issues: Object.freeze(issues) });
}

function externalLink(target) {
  return /^(?:https?:|mailto:)/iu.test(target) || target.startsWith('#');
}

export async function checkDocumentation({ guideRoot, coreVersionPath, commands, packageReadmePath = null }) {
  const root = await realpath(fileURLToPath(guideRoot));
  const issues = [];
  const contents = new Map();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!REQUIRED.includes(entry.name)) {
      issues.push(docIssue('GUIDE_FILE_UNEXPECTED', entry.name, 'Guide root must contain exactly the published 14-file inventory.'));
    }
  }
  for (const name of REQUIRED) {
    const path = resolve(root, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        issues.push(docIssue('GUIDE_FILE_UNSAFE', name, 'Required guide entry must be a regular non-symlink file.'));
        continue;
      }
      const canonical = await realpath(path);
      if (!insideRoot(root, canonical)) {
        issues.push(docIssue('GUIDE_FILE_UNSAFE', name, 'Required guide entry resolves outside the guide root.'));
        continue;
      }
      contents.set(name, await readFile(path, 'utf8'));
    } catch (error) {
      issues.push(docIssue(error.code === 'ENOENT' ? 'GUIDE_FILE_MISSING' : 'GUIDE_FILE_UNSAFE', name, error.message));
    }
  }
  const coreVersion = (await readFile(coreVersionPath, 'utf8')).trim();
  const guideVersion = contents.get('README.md')?.match(/^core_version:\s*([^\s]+)$/mu)?.[1];
  if (guideVersion !== coreVersion) issues.push(docIssue('GUIDE_CORE_VERSION', 'README.md', `Expected core_version: ${coreVersion}`));
  const publicDocuments = new Map(contents);
  if (packageReadmePath !== null) {
    try {
      publicDocuments.set('package:README.md', await readFile(packageReadmePath, 'utf8'));
    } catch (error) {
      issues.push(docIssue('PACKAGE_README_UNREADABLE', 'package:README.md', error.message));
    }
  }
  for (const [name, content] of publicDocuments) {
    if (/\bnode\s+(?:\.\/)?src\/cli\.js\b/u.test(content)) {
      issues.push(docIssue('DEPRECATED_DIRECT_CLI_PATH', name, 'Use the installed research-os command or node bin/research-os.js, never node src/cli.js.'));
    }
    if (/(?:初始化后|初始化完成后)[^\n。]{0,80}(?:已经配置完成|已配置好|就是已配置项目)/u.test(content)) {
      issues.push(docIssue('SKELETON_FALSELY_CONFIGURED', name, 'Project init creates an unconfigured skeleton, not a configured project.'));
    }
  }
  const installationGuide = contents.get('01-installation-and-first-project.md') ?? '';
  for (const [needle, code, message] of [
    ['research-os skill install --target', 'SKILL_INSTALL_STEP_MISSING', 'Installation guide must install the Research OS Skill.'],
    ['research-os skill verify --target', 'SKILL_VERIFY_STEP_MISSING', 'Installation guide must verify the installed Research OS Skill.'],
    ['research-os guide locate', 'GUIDE_LOCATE_STEP_MISSING', 'Installation guide must show the discoverable guide locator.'],
    ['research-os project setup-status --project', 'SETUP_STATUS_STEP_MISSING', 'Installation guide must expose the post-init setup handshake.']
  ]) {
    if (!installationGuide.includes(needle)) issues.push(docIssue(code, '01-installation-and-first-project.md', message));
  }
  let checkedCommands = 0;
  for (const [name, content] of contents) {
    let heading = '';
    let inFence = false;
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/^\s*```/u.test(line)) inFence = !inFence;
      if (!inFence && /^#{1,6}\s+/u.test(line)) heading = line.replace(/^#{1,6}\s+/u, '');
      const absolute = /(?:^|[\s"'(`=])\/(?![/.])[A-Za-z0-9._~-]+\/[A-Za-z0-9._~/-]+/u.test(line);
      if (absolute && !/(?:注册.*资源|资源.*注册|resource registration)/iu.test(heading)) {
        issues.push(docIssue('ABSOLUTE_PATH_EXAMPLE', `${name}:${index + 1}`, 'Absolute machine path is allowed only in a resource-registration section.'));
      }
      const marker = /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b|\{\{[A-Z0-9_]+\}\}/u.test(line);
      if (marker && !markerAllowed(name, heading)) {
        issues.push(docIssue('UNFINISHED_MARKER', `${name}:${index + 1}`, 'Unfinished marker appears outside its validation-rule explanation.'));
      }
    }
    const references = markdownAuthorities(content);
    for (const issue of references.issues) issues.push(docIssue(issue.code, name, issue.message));
    for (const target of [...references.targets, ...references.definitions.map(definition => definition.target)]) {
      if (externalLink(target)) continue;
      const issue = await validateRelativeLink({ root, sourcePath: resolve(root, name), target });
      if (issue) issues.push(docIssue(issue.code, name, issue.message));
    }
    for (const logicalLine of logicalLines(content)) {
      if (logicalLine.danglingContinuation) {
        issues.push(docIssue('INVALID_CLI_INVOCATION', `${name}:${logicalLine.line}`, 'Dangling shell line continuation.'));
        continue;
      }
      if (name === '12-cli-and-schema-reference.md' && /^\s*\|\s*`research-os\s/u.test(logicalLine.text)) continue;
      for (const invocation of invocationSegments(logicalLine.text)) {
        let tokens;
        try { tokens = shellTokens(invocation); }
        catch (error) {
          issues.push(docIssue('INVALID_CLI_INVOCATION', `${name}:${logicalLine.line}`, `${invocation}: ${error.message}`));
          continue;
        }
        if (tokens.length === 1) continue;
        checkedCommands += 1;
        const registered = registeredCommand(tokens.slice(1), commands);
        if (!registered) {
          issues.push(docIssue('UNKNOWN_CLI_COMMAND', `${name}:${logicalLine.line}`, invocation));
          continue;
        }
        const optionTokens = tokens.slice(1 + registered.length);
        if (optionTokens.some((token, index) => index % 2 === 0 && !token.startsWith('--'))) {
          issues.push(docIssue('UNKNOWN_CLI_COMMAND', `${name}:${logicalLine.line}`, invocation));
          continue;
        }
        try {
          parseOptions(optionTokens, commands.get(registered.path));
        } catch (error) {
          issues.push(docIssue('INVALID_CLI_INVOCATION', `${name}:${logicalLine.line}`, `${invocation}: ${error.message}`));
        }
      }
    }
  }
  const referenceName = '12-cli-and-schema-reference.md';
  const seenReferenceCommands = new Set();
  for (const row of referenceRows(contents.get(referenceName) ?? '')) {
    const spec = commands.get(row.path);
    if (!spec) {
      issues.push(docIssue('CLI_REFERENCE_COMMAND_UNEXPECTED', referenceName, `Unknown CLI reference row: ${row.path}`));
      continue;
    }
    if (seenReferenceCommands.has(row.path)) {
      issues.push(docIssue('CLI_REFERENCE_COMMAND_DUPLICATE', referenceName, `Duplicate CLI reference row: ${row.path}`));
      continue;
    }
    seenReferenceCommands.add(row.path);
    const expectedOptional = spec.allowed.filter(option => !spec.required.includes(option));
    if (JSON.stringify(row.required) !== JSON.stringify(spec.required) || JSON.stringify(row.optional) !== JSON.stringify(expectedOptional)) {
      issues.push(docIssue('CLI_REFERENCE_OPTIONS_MISMATCH', referenceName, `CLI reference options do not match runtime: ${row.path}`));
    }
  }
  for (const command of commands.keys()) {
    if (!seenReferenceCommands.has(command)) {
      issues.push(docIssue('CLI_REFERENCE_COMMAND_MISSING', referenceName, `Missing CLI reference row: ${command}`));
    }
  }
  return Object.freeze({ requiredFiles: REQUIRED.length, checkedCommands, issues: Object.freeze(issues.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en'))) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await checkDocumentation({
    guideRoot: new URL('../docs/user-guide/', import.meta.url),
    coreVersionPath: new URL('../core/VERSION', import.meta.url),
    commands: COMMANDS,
    packageReadmePath: new URL('../README.md', import.meta.url)
  });
  for (const issue of report.issues) console.error(`[${issue.code}] ${issue.path}: ${issue.message}`);
  process.exitCode = report.issues.length === 0 ? 0 : 1;
}
