import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

/** Local checkpoint advice only: Git state is never forecast or scientific authority. */
export async function checkpointRepositoryStatus(projectRoot) {
  try {
    const { stdout } = await execute('git', ['-C', projectRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { maxBuffer: 1024 * 1024 });
    const paths = [];
    const entries = stdout.split('\0');
    for (let index = 0; index < entries.length; index++) {
      if (!entries[index]) continue;
      const status = entries[index].slice(0, 2);
      const path = entries[index].slice(3);
      if (/\.md$|plans\/logs\/.*\.json$/u.test(path) && !/(^|\/)(generated|node_modules|\.tmp)\//u.test(path)) paths.push(path);
      if (/[RC]/u.test(status)) index += 1;
    }
    return { applicable: true, uncommittedRecords: paths, message: paths.length ? 'Review and commit the changed project records at this checkpoint.' : 'Project records have no uncommitted changes.' };
  } catch (error) {
    return { applicable: false, uncommittedRecords: [], message: error.stderr?.includes('not a git repository') ? 'This Vault is not in a Git repository.' : `Git status unavailable: ${error.code}` };
  }
}
