// Isolate every test run from the developer's own git and git-tidy config.
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'git-tidy-env-')));
const gitconfig = join(home, 'gitconfig');
writeFileSync(
  gitconfig,
  '[user]\n\tname = git-tidy test\n\temail = git-tidy@test.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.TIDY_HOME = join(home, 'config');
