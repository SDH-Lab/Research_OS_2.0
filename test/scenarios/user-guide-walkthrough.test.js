import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../../src/lib/markdown.js';
import { captureIo, configureSessionFixture, makeTempDir, validContract, validManifest } from '../helpers/fixtures.js';

test('published CLI walkthrough closes one synthetic revision Concern', async () => {
  const root = join(await makeTempDir(), 'revision-vault');
  const outputs = [];
  async function run(args) {
    const capture = captureIo();
    const code = await main(args, capture.io);
    const output = capture.output();
    assert.equal(code, 0, `${args.join(' ')}\n${output.stderr}\n${output.stdout}`);
    outputs.push({ args, output });
    return output.stdout ? JSON.parse(output.stdout) : null;
  }
  const values = value => JSON.stringify(value);
  await run(['project', 'init', '--target', root, '--id', 'walkthrough', '--title', 'Synthetic Revision', '--stage', 'revision']);
  for (const [name, uri, role, access, identity] of [
    ['review', './inputs/review', 'decision-letter', 'read-only', 'review-v1'],
    ['sample_code', 'ssh://research.example.org/worktrees/sample_code', 'implementation', 'read-only', 'sample-v1'],
    ['data', 'ssh://research.example.org/data', 'input-data', 'read-only', 'data-v1'],
    ['models', 'ssh://research.example.org/models', 'model-input', 'read-only', 'models-v1'],
    ['experiment_results', 'ssh://research.example.org/results', 'experiment-results', 'read-write', 'results-v1'],
    ['paper', './writing/paper', 'canonical-paper', 'read-write', 'paper-v1']
  ]) await run(['project', 'resource', 'add', '--project', root, '--name', name, '--uri', uri, '--role', role, '--access', access, '--identity', identity]);
  const projectPath = join(root, 'PROJECT.md');
  const project = parseMarkdownDocument(await readFile(projectPath, 'utf8'), projectPath);
  await writeFile(projectPath, serializeMarkdownDocument({
    ...project.attributes,
    approved_code_roots: ['sample_code'],
    canonical_writing_sources: {
      response: { resource_ref: 'paper:response.tex', source_identity: 'response-v1', content_identity: 'response-content-v1' },
      manuscript_clean: { resource_ref: 'paper:manuscript-clean.tex', source_identity: 'clean-v1', content_identity: 'manuscript-content-v1' },
      manuscript_marked: { resource_ref: 'paper:manuscript-marked.tex', source_identity: 'marked-v1', content_identity: 'manuscript-content-v1' }
    }
  }, project.body), 'utf8');

  const manifest = await run(['experiment', 'manifest-check', '--project', root, '--manifest', values(validManifest())]);
  const contract = validContract();
  const diff = await run(['experiment', 'contract-diff', '--project', root, '--contract', values(contract), '--manifest', values(manifest)]);
  const receipt = await run(['experiment', 'authorize', '--project', root, '--diff', values(diff), '--mechanical-smoke', 'pass', '--semantic-smoke', 'pass', '--waivers', '[]']);
  assert.equal(receipt.authorizationScope, 'provenance-promotion-only; does-not-execute-command-or-set-run-official');

  await run(['record', 'new', '--project', root, '--type', 'concern', '--id', 'CON-101', '--title', 'Reviewer endpoint concern', '--values', values({
    source: 'Reviewer 1', source_comment_id: 'R1-C1', source_ref: 'review:decision-letter.txt', question: 'Does the registered endpoint improve?',
    importance: 'Required for revision.', scope: 'Registered endpoint.', priority: 'high', closure_conditions: ['Two Actions and response are checked.'], actions: ['ACT-101', 'ACT-102']
  })]);
  await run(['record', 'new', '--project', root, '--type', 'action', '--id', 'ACT-101', '--title', 'Run registered comparison', '--values', values({
    driver: 'CON-101', purpose: 'Produce checked evidence.', inputs: [], outputs: ['EVD-101'], dependencies: [], acceptance: 'Result accepted.', risks: [], writer: 'foreground', next_step: 'Inspect protocol checks.', domain: 'experiment', size: 'medium', blockers: []
  })]);
  await run(['record', 'new', '--project', root, '--type', 'action', '--id', 'ACT-102', '--title', 'Write response', '--values', values({
    driver: 'CON-101', purpose: 'Synchronize response and manuscript.', inputs: ['EVD-101'], outputs: ['WRT-102'], dependencies: ['ACT-101'], acceptance: 'Coverage passes.', risks: [], writer: 'foreground', next_step: 'Validate response block.', domain: 'writing', size: 'small', blockers: []
  })]);
  await run(['record', 'new', '--project', root, '--type', 'experiment', '--id', 'EXP-101', '--title', 'Registered comparison', '--values', values({
    scientific_question: 'Does the endpoint improve?', variables: ['method'], fixed_conditions: ['split-v1'], data_model_boundary: 'Registered cohort.', priors_and_bias: [], forbidden_shortcuts: ['No test tuning.'], outcome_definitions: { primary: 'auroc' }, stopping_conditions: ['One official run.'], acceptance: 'Protocol checks pass.'
  })]);
  await run(['record', 'new', '--project', root, '--type', 'manifest', '--id', 'MAN-101', '--title', 'Implementation snapshot', '--values', values({ code_root: 'sample_code' })]);
  const manifestPath = join(root, 'experiments/manifests/MAN-101.md');
  const manifestDocument = parseMarkdownDocument(await readFile(manifestPath, 'utf8'), manifestPath);
  await writeFile(manifestPath, serializeMarkdownDocument({ ...manifestDocument.attributes, ...manifest }, manifestDocument.body), 'utf8');
  await run(['record', 'new', '--project', root, '--type', 'run', '--id', 'RUN-101', '--title', 'Official synthetic run', '--values', values({
    experiment: 'EXP-101', manifest: 'MAN-101', started_at: '2026-08-04T01:00:00.000Z', ended_at: '2026-08-04T02:00:00.000Z', run_status: 'completed', logs: ['experiment_results:EXP-101/run.log'], artifacts: ['experiment_results:EXP-101/metrics.json'], failure_details: '', official: true
  })]);
  await run(['record', 'new', '--project', root, '--type', 'result', '--id', 'RES-101', '--title', 'Accepted endpoint result', '--values', values({
    run: 'RUN-101', protocol_checks: ['pass'], numeric_checks: ['pass'], classification: 'adopted', adoption_reason: 'Registered checks pass.', limitations: ['Synthetic fixture only.'], follow_up: []
  })]);
  await run(['record', 'new', '--project', root, '--type', 'evidence', '--id', 'EVD-101', '--title', 'Endpoint evidence', '--values', values({
    sources: ['RES-101', 'CON-101'], figures_and_numbers: [], interpretation: 'The registered comparison supports the answer.', counterevidence: [], limitations: ['Synthetic fixture only.'], supported_claims: ['CLM-101'], unsupported_claims: [], writing_destinations: ['WRT-101']
  })]);
  await run(['record', 'new', '--project', root, '--type', 'claim', '--id', 'CLM-101', '--title', 'Approved endpoint claim', '--values', values({
    statement: 'The registered comparison supports the requested clarification.', evidence: ['EVD-101'], conditions: ['Registered cohort.'], prohibited_expansion: ['No external claim.'], confidence_and_limitations: 'One synthetic accepted run.', use_locations: ['WRT-101'], approval_status: 'approved', reopen_conditions: ['Source correction.']
  })]);
  await run(['record', 'new', '--project', root, '--type', 'manuscript-change', '--id', 'WRT-102', '--title', 'Synchronized manuscript change', '--values', values({
    purpose: 'Update both manuscript variants.', claims: ['CLM-101'], target_location: 'Section Results', draft: 'The registered comparison supports the requested clarification.', synchronization_status: 'synchronized', verification_result: 'passed', target_source_keys: ['manuscript_clean', 'manuscript_marked'], source_identities: { manuscript_clean: 'clean-v1', manuscript_marked: 'marked-v1' }, location_anchor: 'sec:results', change_summary: 'Added registered comparison.', response_blocks: ['WRT-101'], numeric_sources: []
  })]);
  await run(['record', 'new', '--project', root, '--type', 'response', '--id', 'WRT-101', '--title', 'Reviewer response block', '--values', values({
    purpose: 'Answer R1-C1.', claims: ['CLM-101'], target_location: 'response:R1-C1', draft: 'We agree. The registered comparison supports the requested clarification.', synchronization_status: 'synchronized', verification_result: 'passed', concern: 'CON-101', direct_answer: 'Yes. The registered comparison supports the requested clarification.', evidence_or_reason: ['EVD-101'], limitations: 'The evidence is limited to the registered cohort.', manuscript_changes: ['WRT-102'], covered_actions: ['ACT-101', 'ACT-102'], numeric_sources: []
  })]);

  await configureSessionFixture(root, { objective: 'Submit the checked synthetic response.', plan: { writable_paths: ['writing/**', 'plans/actions/**'] } });
  const close = async id => {
    if (id.startsWith('ACT-')) {
      await run(['action','configure','--project',root,'--id',id,'--definition',values({candidate_version:'v1',validation_plan:{tier:'scientific',checks:[{id:'evidence',description:'Inspect registered evidence',max_attempts:1}]},operation_scope:{operations:['validate'],paths:['writing/**'],resources:[]}})]);
      await run(['action','approve','--project',root,'--id',id,'--approval',values({grant_id:'fixture',approver:'researcher',reason:'Synthetic fixture approval'})]);
    }
    for (const status of ['defined', 'ready', 'in_progress']) await run(['record', 'status', '--project', root, '--id', id, '--to', status, '--reason', `Move ${id} to ${status}.`]);
    if (id.startsWith('ACT-')) await run(['action','check','--project',root,'--id',id,'--check',values({check_id:'evidence',candidate_version:'v1',outcome:'pass',evidence:'Synthetic evidence checked'})]);
    await run(['record', 'status', '--project', root, '--id', id, '--accepted-by', 'researcher', '--to', 'closed', '--reason', `Verified ${id}.`, '--verified-at', '2026-08-04T03:00:00.000Z']);
  };
  for (const status of ['ready', 'in_progress']) await run(['record', 'status', '--project', root, '--id', 'MAN-101', '--to', status, '--reason', `Move MAN-101 to ${status}.`]);
  await run(['record', 'status', '--project', root, '--id', 'MAN-101', '--to', 'closed', '--reason', 'Verified MAN-101.', '--verified-at', '2026-08-04T03:00:00.000Z']);
  for (const id of ['EXP-101', 'RUN-101', 'RES-101', 'EVD-101', 'CLM-101', 'WRT-102', 'WRT-101', 'ACT-101', 'ACT-102']) await close(id);
  await close('CON-101');
  await run(['session', 'checkpoint', '--project', root, '--update', values({
    progress: ['Synthetic response graph closed.'], artifacts: ['writing/response/WRT-101.md'], discoveries: [], decisions: ['Use the registered comparison.'],
    resumePoint: { lastVerifiedPoint: 'Concern coverage checked.', nextAction: 'Rebuild views and validate.', nextCommandOrEdit: 'research-os view build --project ./revision-vault', requiredFiles: ['PROJECT.md', 'plans/active.md', 'writing/response/WRT-101.md'], risks: [], reforecastTrigger: null }
  })]);
  await run(['view', 'build', '--project', root]);
  await run(['record', 'validate', '--project', root]);
  const coverage = await run(['writing', 'coverage', '--project', root]);
  assert.equal(coverage.closable, true);
  assert.equal(coverage.concerns['CON-101'].closable, true);
  assert.equal(outputs.every(item => item.output.stderr === ''), true);
});
