import { spawnSync } from 'node:child_process';

for (const args of [['--test'], ['scripts/check-docs.js']]) {
  const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.exitCode = child.status ?? 1;
    break;
  }
}
