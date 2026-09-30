// Dashboard + promotion worker against an in-memory GitHub, so the Promotions flow can be tried
// without touching a real repo. Open PRs are "merged" automatically every MERGE_EVERY_MS.
// Run: pnpm demo:promotions   (uses its own config dir; your registry is untouched)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { History, PromotionStore, PromotionWorker, Registry, SettingsStore, type GitHubClient } from '../packages/core/src/index.js';
import { startServer } from '../packages/server/src/index.js';
import { FakeGitHub } from '../packages/core/test/fakeGithub.js';

const MERGE_EVERY_MS = Number(process.env.MERGE_EVERY_MS ?? 20_000);
const dir = mkdtempSync(join(tmpdir(), 'git-helper-promo-demo-'));
const registry = new Registry(join(dir, 'repos.json'));

for (const name of ['api', 'web']) {
  const repo = join(dir, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const entry = await registry.add(repo, { name });
  registry.setPipeline(entry.id, { stages: ['develop', 'qa', 'stage', 'main'], autoMerge: name === 'api' ? ['develop→qa'] : undefined });
}

// One in-memory GitHub repo per demo repo, addressed by slug like the real client.
const fakes = new Map<string, FakeGitHub>([
  ['demo/api', new FakeGitHub({ main: ['a'], stage: ['a'], qa: ['a', 'b'], develop: ['a', 'b', 'c', 'd'] })],
  ['demo/web', new FakeGitHub({ main: ['a'], stage: ['a'], qa: ['a'], develop: ['a', 'b'] })],
]);
const fake = (slug: string) => fakes.get(slug)!;
const github: GitHubClient = {
  repoSlug: async (path) => `demo/${basename(path)}`,
  compare: (slug, b, h) => fake(slug).compare(slug, b, h),
  findOpenPr: (slug, b, h) => fake(slug).findOpenPr(slug, b, h),
  createPr: (slug, pr) => fake(slug).createPr(slug, pr),
  getPr: (slug, n) => fake(slug).getPr(slug, n),
  enableAutoMerge: (slug, n) => fake(slug).enableAutoMerge(slug, n),
};
const settings = new SettingsStore(join(dir, 'settings.json'));
settings.update({ promotionIntervalSec: 10 });
const worker = new PromotionWorker({ registry, github, store: new PromotionStore(join(dir, 'promotions.json')), lockFile: join(dir, 'worker.lock'), settings });
const running = await startServer({
  registry,
  history: new History(join(dir, 'history.jsonl')),
  worker,
  port: Number(process.env.PORT ?? 4322),
  webDir: fileURLToPath(new URL('../packages/web/dist', import.meta.url)),
});

setInterval(() => {
  for (const [slug, gh] of fakes) {
    for (const pr of gh.prs.filter((p) => p.state === 'OPEN')) {
      gh.merge(pr.number);
      console.log(`(demo) merged ${slug}#${pr.number} ${pr.head} → ${pr.base}`);
    }
  }
}, MERGE_EVERY_MS);

console.log(`Promotions demo: ${running.url}#/promotions`);
