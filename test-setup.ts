// Isolate every test run from the developer's own git and git-helper config.
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'git-helper-env-')));
const gitconfig = join(home, 'gitconfig');
writeFileSync(
  gitconfig,
  '[user]\n\tname = git-helper test\n\temail = git-helper@test.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_HELPER_HOME = join(home, 'config');
