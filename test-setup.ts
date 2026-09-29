// Isolate every test run from the developer's own git and git-switcher config.
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'gsw-env-')));
const gitconfig = join(home, 'gitconfig');
writeFileSync(
  gitconfig,
  '[user]\n\tname = gsw test\n\temail = gsw@test.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_SWITCHER_HOME = join(home, 'config');
