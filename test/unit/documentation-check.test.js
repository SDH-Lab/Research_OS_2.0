import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkDocumentation } from '../../scripts/check-docs.js';
import { COMMANDS } from '../../src/cli.js';
import { makeTempDir } from '../helpers/fixtures.js';

test('published guide has all 14 files and passes mechanical authority checks', async () => {
  const report = await checkDocumentation({
    guideRoot: new URL('../../docs/user-guide/', import.meta.url),
    coreVersionPath: new URL('../../core/VERSION', import.meta.url),
    commands: COMMANDS,
    packageReadmePath: new URL('../../README.md', import.meta.url)
  });
  assert.equal(report.requiredFiles, 14);
  assert.deepEqual(report.issues, []);
  assert.equal(report.checkedCommands > 0, true);
});

test('documentation checker enforces capability installation and unconfigured-skeleton language', async () => {
  const { root } = await copiedGuide();
  const installPath = join(root, '01-installation-and-first-project.md');
  const install = await readFile(installPath, 'utf8');
  await writeFile(installPath, `${install.replaceAll('research-os skill install --target', 'research-os skill omitted --target')}\n初始化后已经配置完成，可以直接工作。\n`, 'utf8');
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\nnode src/cli.js --help\n`, 'utf8');

  const report = await inspectGuide(root);
  const codes = new Set(report.issues.map(item => item.code));
  for (const code of ['SKILL_INSTALL_STEP_MISSING', 'SKELETON_FALSELY_CONFIGURED', 'DEPRECATED_DIRECT_CLI_PATH']) {
    assert.equal(codes.has(code), true, `${code}: ${JSON.stringify(report.issues)}`);
  }
});

test('documentation checker rejects broken links, unknown commands, arbitrary absolute paths, and unfinished tokens', async () => {
  const root = join(await makeTempDir(), 'guide');
  await cp(new URL('../../docs/user-guide/', import.meta.url), root, { recursive: true });
  const path = join(root, '10-maintenance-troubleshooting-and-backup.md');
  await writeFile(path, `${await readFile(path, 'utf8')}\n[broken](missing.md)\n\`research-os view invent --project ./demo\`\n\`/etc/secret\`\nTODO\n{{UNRESOLVED}}\n`, 'utf8');
  const report = await checkDocumentation({
    guideRoot: pathToFileURL(`${root}/`),
    coreVersionPath: new URL('../../core/VERSION', import.meta.url),
    commands: COMMANDS
  });
  const codes = new Set(report.issues.map(item => item.code));
  for (const code of ['BROKEN_RELATIVE_LINK', 'UNKNOWN_CLI_COMMAND', 'ABSOLUTE_PATH_EXAMPLE', 'UNFINISHED_MARKER']) assert.equal(codes.has(code), true, code);
});

async function copiedGuide() {
  const base = await makeTempDir();
  const root = join(base, 'guide');
  await cp(new URL('../../docs/user-guide/', import.meta.url), root, { recursive: true });
  return { base, root };
}

async function inspectGuide(root) {
  return checkDocumentation({
    guideRoot: pathToFileURL(`${root}/`),
    coreVersionPath: new URL('../../core/VERSION', import.meta.url),
    commands: COMMANDS
  });
}

test('documentation links are root-contained, guarded, and regular-file only', async t => {
  const cases = [
    ['malformed encoding', '[bad](%ZZ.md)', 'MALFORMED_RELATIVE_LINK'],
    ['raw traversal', '[bad](../outside.md)', 'UNSAFE_RELATIVE_LINK'],
    ['encoded traversal', '[bad](..%2Foutside.md)', 'UNSAFE_RELATIVE_LINK'],
    ['directory target', '[bad](directory-target)', 'BROKEN_RELATIVE_LINK'],
    ['symlink target', '[bad](symlink-target.md)', 'UNSAFE_RELATIVE_LINK']
  ];
  for (const [name, linkText, code] of cases) {
    await t.test(name, async () => {
      const { base, root } = await copiedGuide();
      await writeFile(join(base, 'outside.md'), '# Outside\n', 'utf8');
      await mkdir(join(root, 'directory-target'));
      await symlink(join(base, 'outside.md'), join(root, 'symlink-target.md'));
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${linkText}\n`, 'utf8');
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => item.code === code), true, JSON.stringify(report.issues));
    });
  }
});

test('documentation CLI validation rejects trailing positionals and malformed options from shared specs', async t => {
  for (const invocation of [
    'research-os view build invent --project ./demo',
    'research-os doctor evil --project ./demo',
    'research-os view build --unknown value --project ./demo',
    'research-os view build',
    'research-os view build --project',
    'research-os view build --project ./a --project ./b'
  ]) {
    await t.test(invocation, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n\`${invocation}\`\n`, 'utf8');
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => ['INVALID_CLI_INVOCATION', 'UNKNOWN_CLI_COMMAND'].includes(item.code)), true, JSON.stringify(report.issues));
    });
  }
});

test('documentation inventory is exact and unfinished-marker exemptions are fixed by file and heading', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, '14-extra.md'), '# Extra\n\nTODO marker: unfinished.\n[bad](missing.md)\n', 'utf8');
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n## Marker notes\n\nTODO finish this.\n`, 'utf8');
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => item.code === 'GUIDE_FILE_UNEXPECTED' && item.path === '14-extra.md'), true);
  assert.equal(report.issues.some(item => item.code === 'UNFINISHED_MARKER' && item.path.startsWith('README.md:')), true);
});

test('documentation shell lexer rejects malformed quotes/escapes and preserves valid quoting/continuation', async t => {
  for (const invocation of [
    "research-os doctor --project 'unterminated",
    'research-os doctor --project "unterminated',
    'research-os doctor --project ./demo\\'
  ]) {
    await t.test(`rejects ${invocation}`, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n\`${invocation}\`\n`, 'utf8');
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => item.code === 'INVALID_CLI_INVOCATION'), true, JSON.stringify(report.issues));
    });
  }
  for (const invocation of [
    "research-os doctor --project './demo folder'",
    'research-os doctor --project "./demo\\\"quoted"',
    'research-os doctor --project \\\n  ./demo'
  ]) {
    await t.test(`accepts ${invocation}`, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${invocation}\n`, 'utf8');
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => ['INVALID_CLI_INVOCATION', 'UNKNOWN_CLI_COMMAND'].includes(item.code)), false, JSON.stringify(report.issues));
    });
  }
});

test('required guide entries must be root-contained regular non-symlink files', async () => {
  const { root } = await copiedGuide();
  const path = join(root, 'README.md');
  const external = join(await makeTempDir(), 'README.md');
  await rename(path, external);
  await symlink(external, path);
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => item.code === 'GUIDE_FILE_UNSAFE' && item.path === 'README.md'), true);
});

test('CommonMark destinations and optional titles are separated without weakening link safety', async () => {
  const { root } = await copiedGuide();
  const validLinks = [
    '[double](01-installation-and-first-project.md "Install")',
    "[single](01-installation-and-first-project.md 'Install')",
    '[paren](01-installation-and-first-project.md (Install))',
    '[angle](<01-installation-and-first-project.md> "Install")',
    '[space-anchor](<01-installation-and-first-project.md#Install Guide>)',
    '[escaped-parens](01-installation-and-first-project.md#section\\(one\\))',
    '[anchor](01-installation-and-first-project.md#anchor)'
  ];
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${validLinks.join('\n')}\n`, 'utf8');
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => ['BROKEN_RELATIVE_LINK', 'MALFORMED_RELATIVE_LINK', 'UNSAFE_RELATIVE_LINK'].includes(item.code)), false, JSON.stringify(report.issues));
});

test('documentation CLI catalog recognizes bounded Markdown presentation prefixes and optional shell prompts', async t => {
  const prefixes = ['- ', '* ', '+ ', '1. ', '12) ', '> ', '> - ', '$ ', '> 2. $ '];
  for (const prefix of prefixes) {
    await t.test(`invalid ${prefix}`, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${prefix}research-os doctor evil --project ./demo\n`);
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => ['INVALID_CLI_INVOCATION', 'UNKNOWN_CLI_COMMAND'].includes(item.code)), true, JSON.stringify(report.issues));
    });
    await t.test(`valid ${prefix}`, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${prefix}research-os doctor --project ./demo\n`);
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => ['INVALID_CLI_INVOCATION', 'UNKNOWN_CLI_COMMAND'].includes(item.code)), false, JSON.stringify(report.issues));
    });
  }

  await t.test('ordinary prose remains ignored while inline and fenced commands remain checked', async () => {
    const { root } = await copiedGuide();
    await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

This prose mentions research-os doctor evil but is not a command example.

- \`research-os doctor evil --project ./demo\`

\`\`\`bash
research-os doctor evil --project ./demo
\`\`\`
`);
    const report = await inspectGuide(root);
    assert.equal(report.issues.filter(item => ['INVALID_CLI_INVOCATION', 'UNKNOWN_CLI_COMMAND'].includes(item.code)).length, 2, JSON.stringify(report.issues));
  });
});

test('CommonMark reference definitions cover full, collapsed, and shortcut links with normalized labels', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[full][Install Guide]
[Install   Guide][]
[install guide]

[INSTALL guide]: <01-installation-and-first-project.md#Install Guide> "Installation"
`);
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => ['BROKEN_REFERENCE_LINK', 'BROKEN_RELATIVE_LINK', 'MALFORMED_RELATIVE_LINK', 'UNSAFE_RELATIVE_LINK'].includes(item.code)), false, JSON.stringify(report.issues));
});

test('reference definitions use first-definition semantics, reject duplicates, and validate every local destination', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[chapter][ref]
[missing][no-such-label]

[ref]: 01-installation-and-first-project.md "First"
[ REF ]: ../outside.md "Duplicate traversal"
[unused]: missing-reference-target.md
`);
  const report = await inspectGuide(root);
  const codes = new Set(report.issues.map(item => item.code));
  assert.equal(codes.has('DUPLICATE_LINK_DEFINITION'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('BROKEN_REFERENCE_LINK'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('UNSAFE_RELATIVE_LINK'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('BROKEN_RELATIVE_LINK'), true, JSON.stringify(report.issues));
});

test('external URI schemes are case-insensitive for inline and reference links while local traversal stays guarded', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[site](HTTPS://example.com/path)
[mail](MAILTO:person@example.com)
[reference][external]
[bad][local]

[external]: HTTPS://example.com/path "External"
[local]: ..%2Foutside.md
`);
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => item.code === 'BROKEN_RELATIVE_LINK' && /HTTPS|MAILTO/u.test(item.message)), false, JSON.stringify(report.issues));
  assert.equal(report.issues.some(item => item.code === 'UNSAFE_RELATIVE_LINK'), true, JSON.stringify(report.issues));
});

test('CommonMark multiline reference definitions cannot bypass containment and preserve first-definition semantics', async () => {
  const { base, root } = await copiedGuide();
  await writeFile(join(base, 'outside.md'), '# Outside\n', 'utf8');
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[outside][ref]
[valid][chapter]
[duplicate][dup]

[ref]:
  ../outside.md
  "Traversal title
  on two lines"
[chapter]:
  <01-installation-and-first-project.md#Install Guide>
  'A valid title
  on two lines'
[dup]: 01-installation-and-first-project.md "First definition"
[ DUP ]:
  ../outside.md
[unused]:
  missing-multiline-target.md
`, 'utf8');
  const report = await inspectGuide(root);
  const codes = new Set(report.issues.map(item => item.code));
  assert.equal(codes.has('UNSAFE_RELATIVE_LINK'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('DUPLICATE_LINK_DEFINITION'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('BROKEN_RELATIVE_LINK'), true, JSON.stringify(report.issues));
  assert.equal(codes.has('BROKEN_REFERENCE_LINK'), false, JSON.stringify(report.issues));
});

test('multiline reference destination and title boundaries do not consume the following definition', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[first][one]
[second][two]

[one]:
  01-installation-and-first-project.md
  (First title
  continues)
[two]:
  02-mental-model-and-authority.md
`, 'utf8');
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => ['BROKEN_REFERENCE_LINK', 'BROKEN_RELATIVE_LINK', 'MALFORMED_RELATIVE_LINK'].includes(item.code)), false, JSON.stringify(report.issues));
});

test('definition-like text inside a valid multiline title is not indexed as another definition', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

[chapter][ref]

[ref]: 01-installation-and-first-project.md "A title
[shadow]: ../outside.md
that closes here"
`, 'utf8');
  const report = await inspectGuide(root);
  assert.equal(report.issues.some(item => ['DUPLICATE_LINK_DEFINITION', 'UNSAFE_RELATIVE_LINK', 'BROKEN_RELATIVE_LINK', 'MALFORMED_RELATIVE_LINK'].includes(item.code)), false, JSON.stringify(report.issues));
});

test('CommonMark escaped and multiline labels cannot bypass definition containment', async t => {
  const cases = [
    ['escaped closing bracket', String.raw`[a\]]

[a\]]: ../outside.md
[unused\]]: missing-escaped.md`, ['UNSAFE_RELATIVE_LINK', 'BROKEN_RELATIVE_LINK']],
    ['multiline shortcut label', `[Foo
  bar]: ../outside.md

[Foo
  bar]`, ['UNSAFE_RELATIVE_LINK']],
    ['multiline full-reference label', `[outside][Foo
  bar]

[Foo
  bar]: ../outside.md`, ['UNSAFE_RELATIVE_LINK']]
  ];
  for (const [name, markdown, expectedCodes] of cases) {
    await t.test(name, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${markdown}\n`, 'utf8');
      const report = await inspectGuide(root);
      for (const code of expectedCodes) {
        assert.equal(report.issues.some(item => item.code === code), true, `${code}: ${JSON.stringify(report.issues)}`);
      }
      assert.equal(report.issues.some(item => item.code === 'BROKEN_REFERENCE_LINK'), false, JSON.stringify(report.issues));
    });
  }
});

test('CommonMark definitions inside blockquote and list containers remain document authority', async t => {
  for (const [name, markdown] of [
    ['blockquote', '[outside]\n> [outside]: ../outside.md'],
    ['list', '[outside]\n- [outside]: ../outside.md']
  ]) {
    await t.test(name, async () => {
      const { root } = await copiedGuide();
      await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}\n${markdown}\n`, 'utf8');
      const report = await inspectGuide(root);
      assert.equal(report.issues.some(item => item.code === 'UNSAFE_RELATIVE_LINK'), true, JSON.stringify(report.issues));
      assert.equal(report.issues.some(item => item.code === 'BROKEN_REFERENCE_LINK'), false, JSON.stringify(report.issues));
    });
  }
});

test('CommonMark literal blocks do not create link-definition authority or hide real broken references', async () => {
  const { root } = await copiedGuide();
  await writeFile(join(root, 'README.md'), `${await readFile(join(root, 'README.md'), 'utf8')}

\`\`\`markdown
[fenced]: ../outside.md
[missing][only-in-code]
\`\`\`

    [indented]: ../outside.md

<div>
[html]: ../outside.md
</div>

[actual][missing]
`, 'utf8');
  const report = await inspectGuide(root);
  assert.equal(report.issues.filter(item => item.code === 'UNSAFE_RELATIVE_LINK').length, 0, JSON.stringify(report.issues));
  assert.equal(report.issues.filter(item => item.code === 'DUPLICATE_LINK_DEFINITION').length, 0, JSON.stringify(report.issues));
  const broken = report.issues.filter(item => item.code === 'BROKEN_REFERENCE_LINK');
  assert.equal(broken.length, 1, JSON.stringify(report.issues));
  assert.match(broken[0].message, /missing/u);
});
