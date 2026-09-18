import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, main } from '../../src/cli.js';

test('help lists stable top-level command groups', async () => {
  let output = '';
  const code = await main(['--help'], { stdout: s => { output += s; }, stderr: () => {} });
  assert.equal(code, 0);
  for (const name of ['project', 'module', 'record', 'session', 'experiment', 'writing', 'view', 'forecast', 'core', 'skill', 'guide', 'doctor']) {
    assert.match(output, new RegExp(`\\b${name}\\b`));
  }
});

test('public command catalog contains exact full command paths', () => {
  assert.deepEqual([...COMMANDS.keys()], [
    'project init', 'project show', 'project setup-status', 'project rebaseline', 'project recover',
    'action configure', 'action check', 'action blocker', 'action approve', 'action claim', 'action ready', 'artifact accept', 'project resource add', 'project resource list', 'project resource resolve', 'project index add', 'project index list',
    'module enable', 'record new', 'record status', 'record validate', 'record trace',
    'session context', 'session preflight', 'session background', 'session checkpoint', 'session check-diff', 'session disruption',
    'experiment manifest-check', 'experiment contract-diff', 'experiment authorize',
    'writing coverage', 'writing validate-block', 'writing delivery-check',
    'view build', 'view clean', 'view show', 'forecast calculate',
    'core upgrade-preview', 'core upgrade-apply',
    'skill install', 'skill verify', 'guide locate', 'doctor'
  ]);
});
