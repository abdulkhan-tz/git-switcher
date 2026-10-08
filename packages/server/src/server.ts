import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { clearGitCache, listBranches, serviceGit, ServiceError, ServiceManager, History, PromotionError, PromotionWorker, Registry, RegistryError, SettingsError, foldedHeads, repairCase, inspect, listWorktrees, repoExists, worktreeDetails, type RepoEntry } from '@tidy/core';
import { Batch } from './runs.js';

export interface ServerOptions {
  registry?: Registry;
  history?: History;
  /** Fixed token (tests); otherwise random per launch. */
  token?: string;
  port?: number;
  /** Built web UI to serve at `/`. */
  webDir?: string;
  /** Promotion worker; one is created (and started) by default. */
  worker?: PromotionWorker;
  services?: ServiceManager;
  /** Start polling promotions. Default true. */
  pollPromotions?: boolean;
}

export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  /** Dashboard URL including the token. */
  url: string;
  worker: PromotionWorker;
  /** True once the engine on disk was rebuilt after this server loaded it. */
  isStale(): boolean;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** When the engine on disk was last built. A long-running app compares it with what it loaded. */
export function engineBuiltAt(): number {
  try {
    return statSync(fileURLToPath(import.meta.resolve('@tidy/core'))).mtimeMs;
  } catch {
    return 0;
  }
}

export async function repoView(entry: RepoEntry) {
  if (!repoExists(entry)) return { ...entry, missing: true as const, state: null, error: null };
  try {
    const [state, folded] = await Promise.all([inspect(entry.path), foldedHeads(entry.path).catch(() => [])]);
    return { ...entry, missing: false as const, state, folded, error: null };
  } catch (e) {
    return { ...entry, missing: false as const, state: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const registry = opts.registry ?? new Registry();
  const history = opts.history ?? new History();
  const token = opts.token ?? randomBytes(16).toString('hex');
  const worker = opts.worker ?? new PromotionWorker({ registry });
  const loadedBuild = engineBuiltAt();
  const isStale = () => engineBuiltAt() > loadedBuild;
  const batches = new Map<string, Batch>();
  const busy = new Set<string>();
  const services = opts.services ?? new ServiceManager();
  /** Starting a service can take minutes, so the API answers at once; a failure is shown on the next poll. */
  const serviceJobs = new Map<string, { action: 'starting' | 'stopping' | 'switching' | 'restarting'; error?: string }>();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new HttpError(413, 'body too large');
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
  };

  const repoOr404 = (id: string) => {
    const entry = registry.find(id);
    if (!entry) throw new HttpError(404, `no registered repo "${id}"`);
    return entry;
  };

  const optStr = (v: unknown) => (typeof v === 'string' ? v : undefined);

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
    const [resource, id, sub] = parts;

    if (resource === 'repos') {
      if (!id && method === 'GET') return json(res, 200, await Promise.all(registry.list().map(repoView)));
      if (!id && method === 'POST') {
        const b = await readBody(req);
        if (typeof b.path !== 'string' || !b.path) throw new HttpError(400, 'path is required');
        const entry = await registry.add(b.path, { name: optStr(b.name) || undefined, base: optStr(b.base) || undefined, remote: optStr(b.remote) || undefined });
        return json(res, 201, await repoView(entry));
      }
      if (id && !sub && method === 'GET') return json(res, 200, await repoView(repoOr404(id)));
      if (id && !sub && method === 'PATCH') {
        const b = await readBody(req);
        repoOr404(id);
        return json(res, 200, await repoView(registry.update(id, { name: optStr(b.name), base: optStr(b.base), remote: optStr(b.remote) })));
      }
      if (id && !sub && method === 'DELETE') return json(res, 200, registry.remove(repoOr404(id).id));
      if (id && sub === 'pipeline' && method === 'PUT') {
        const b = await readBody(req);
        if (!Array.isArray(b.stages)) throw new HttpError(400, 'stages must be an array');
        const autoMerge = Array.isArray(b.autoMerge) ? b.autoMerge.map(String) : undefined;
        return json(res, 200, await repoView(registry.setPipeline(repoOr404(id).id, { stages: b.stages.map(String), autoMerge })));
      }
      if (id && sub === 'pipeline' && method === 'DELETE') return json(res, 200, await repoView(registry.setPipeline(repoOr404(id).id, null)));
      if (id && sub === 'repair' && method === 'POST') {
        const entry = repoOr404(id);
        const repaired = await repairCase(entry.path).catch((e: Error) => {
          throw new HttpError(409, e.message);
        });
        return json(res, 200, { repaired, repo: await repoView(entry) });
      }
      if (id && sub === 'branches' && method === 'GET') return json(res, 200, await listBranches(repoOr404(id).path));
      if (id && sub === 'worktrees' && method === 'GET') {
        const entry = repoOr404(id);
        const wts = await listWorktrees(entry.path);
        return json(res, 200, await Promise.all(wts.map((w) => worktreeDetails(entry.path, w))));
      }
    }

    if (resource === 'groups') {
      if (!id && method === 'GET') return json(res, 200, registry.groups());
      if (id && method === 'PUT') {
        const b = await readBody(req);
        if (!Array.isArray(b.repoIds)) throw new HttpError(400, 'repoIds must be an array');
        return json(res, 200, registry.setGroup(id, b.repoIds.map(String)));
      }
      if (id && method === 'DELETE') return registry.removeGroup(id), json(res, 200, { ok: true });
    }

    if (resource === 'promotions') {
      if (!id && method === 'GET') {
        return json(res, 200, { promotions: worker.store.list(), worker: worker.status() });
      }
      if (!id && method === 'DELETE') return json(res, 200, { removed: worker.clearFinished() });
      if (!id && method === 'POST') {
        const b = await readBody(req);
        if (!Array.isArray(b.repoIds) || b.repoIds.length === 0) throw new HttpError(400, 'repoIds must be a non-empty array');
        const from = optStr(b.from)?.trim() || undefined;
        const started = [];
        const errors: { repo: string; error: string }[] = [];
        for (const ref of b.repoIds.map(String)) {
          try {
            started.push(await worker.startPromotion(ref, { from }));
          } catch (e) {
            if (!(e instanceof PromotionError)) throw e;
            errors.push({ repo: registry.find(ref)?.name ?? ref, error: e.message });
          }
        }
        return json(res, started.length ? 201 : 400, { started, errors });
      }
      if (id === 'tick' && method === 'POST') return await worker.checkNow(), json(res, 200, worker.status());
      if (id && !sub && method === 'DELETE') return json(res, 200, worker.deletePromotion(id));
      if (id && sub === 'stop' && method === 'POST') return json(res, 200, worker.stopPromotion(id));
      if (id && sub === 'resume' && method === 'POST') return json(res, 200, await worker.resumePromotion(id));
    }

    if (resource === 'settings') {
      if (method === 'GET') return json(res, 200, worker.settings.load());
      if (method === 'PUT') {
        const b = await readBody(req);
        if ('promotionIntervalSec' in b) worker.setIntervalSec(b.promotionIntervalSec as number);
        if ('promotionChecksEnabled' in b) {
          if (typeof b.promotionChecksEnabled !== 'boolean') throw new HttpError(400, 'promotionChecksEnabled must be true or false');
          worker.setChecksEnabled(b.promotionChecksEnabled);
        }
        return json(res, 200, { settings: worker.settings.load(), worker: worker.status() });
      }
    }

    if (resource === 'services') {
      if (!id && method === 'GET') {
        if (url.searchParams.get('fresh') === '1') clearGitCache();
        const rows = await services.status(undefined, { git: true });
        return json(res, 200, rows.map((r) => ({ ...r, job: serviceJobs.get(r.name)?.action, error: r.state === 'up' && serviceJobs.get(r.name)?.action !== 'switching' ? undefined : serviceJobs.get(r.name)?.error })));
      }
      if (id === 'groups') {
        if (!sub && method === 'GET') return json(res, 200, services.store.groups());
        if (sub && method === 'PUT') {
          const b = await readBody(req);
          if (!Array.isArray(b.members)) throw new HttpError(400, 'members must be an array');
          return json(res, 200, services.store.setGroup(sub, b.members.map(String)));
        }
        if (sub && method === 'DELETE') return services.store.removeGroup(sub), json(res, 200, { ok: true });
        if (sub && method === 'POST') {
          const b = await readBody(req);
          if (typeof b.to !== 'string') throw new HttpError(400, 'to is required');
          return json(res, 200, services.store.renameGroup(sub, b.to.trim()));
        }
      }
      if (id && sub === 'rename' && method === 'POST') {
        const b = await readBody(req);
        if (typeof b.to !== 'string') throw new HttpError(400, 'to is required');
        if (serviceJobs.has(id)) throw new HttpError(409, `${id} is busy`);
        return json(res, 200, services.store.rename(id, b.to.trim()));
      }
      if (id && !sub && method === 'PATCH') {
        const b = await readBody(req);
        const clearable = (v: unknown) => (v === null || v === '' ? null : v);
        const patch = {
          cwd: typeof b.cwd === 'string' ? b.cwd : undefined,
          command: typeof b.command === 'string' ? b.command : undefined,
          description: typeof b.description === 'string' ? b.description : undefined,
          prepare: 'prepare' in b ? (clearable(b.prepare) as string | null) : undefined,
          port: b.port === undefined ? undefined : Number(b.port),
          startTimeoutSec: b.startTimeoutSec === undefined ? undefined : (clearable(b.startTimeoutSec === null || b.startTimeoutSec === '' ? null : Number(b.startTimeoutSec)) as number | null),
          dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : undefined,
          env: b.env && typeof b.env === 'object' ? (b.env as Record<string, string>) : undefined,
        };
        services.store.update(id, patch);
        return json(res, 200, services.store.get(id));
      }
      if (id && sub === 'error' && method === 'DELETE') {
        if (serviceJobs.get(id)?.error) serviceJobs.delete(id);
        return json(res, 200, { ok: true });
      }
      if (id && sub === 'branches' && method === 'GET') {
        const git = await serviceGit(services.store.get(id).cwd);
        return json(res, 200, git ? await listBranches(git.root) : { current: null, branches: [] });
      }
      if (id && sub === 'switch' && method === 'POST') {
        const b = await readBody(req);
        const branch = optStr(b.branch)?.trim();
        if (!branch) throw new HttpError(400, 'branch is required');
        services.store.get(id);
        if (serviceJobs.get(id) && !serviceJobs.get(id)!.error) throw new HttpError(409, `${id} is already ${serviceJobs.get(id)!.action}`);
        serviceJobs.set(id, { action: 'switching' });
        void services
          .switchBranch(id, branch, { restart: b.restart !== false })
          .then(({ result }) => {
            history.append(result);
            if (result.outcome === 'switched') serviceJobs.delete(id);
            else serviceJobs.set(id, { action: 'switching', error: `${result.outcome}${result.failedStep ? ` at ${result.failedStep}` : ''}: ${result.error ?? 'nothing was changed'}${result.recovery ? ` — ${result.recovery}` : ''}` });
          })
          .catch((e: Error) => serviceJobs.set(id, { action: 'switching', error: e.message }));
        return json(res, 202, { ok: true });
      }
      if (id && sub === 'git' && method === 'GET') {
        const def = services.store.get(id);
        return json(res, 200, (await serviceGit(def.cwd)) ?? { root: null });
      }
      if (id && sub === 'logs' && method === 'GET') {
        const off = url.searchParams.get('offset');
        return json(res, 200, services.readLog(id, { offset: off === null ? undefined : Number(off) }));
      }
      if (id && sub === 'logs' && method === 'DELETE') return services.clearLog(id), json(res, 200, { ok: true });
      if ((id === 'up' || id === 'down') && !sub && method === 'POST') {
        // POST /services/up|down with {names: []} — an empty list means every service
        const b = await readBody(req);
        const names = Array.isArray(b.names) ? b.names.map(String) : [];
        const targets = names.length ? services.resolve(names) : services.store.list().map((s) => s.name);
        const action = id === 'up' ? 'starting' : 'stopping';
        // Only what will really change is shown as busy: a dependency that is already up is left alone.
        const states = new Map((await services.status()).map((r) => [r.name, r.state]));
        const involved = (id === 'up' ? services.order(targets).map((d) => d.name) : targets).filter((n) => {
          const st = states.get(n);
          return id === 'up' ? st === 'down' : st === 'up' || st === 'starting' || (st === 'external' && b.external === true);
        });
        for (const n of involved) {
          if (serviceJobs.get(n) && !serviceJobs.get(n)!.error) throw new HttpError(409, `${n} is already ${serviceJobs.get(n)!.action}`);
        }
        for (const n of involved) serviceJobs.set(n, { action });
        void (id === 'up' ? services.up(targets) : services.down(targets, undefined, { external: b.external === true }))
          .catch((e: Error) => {
            for (const n of involved) if (serviceJobs.has(n)) serviceJobs.set(n, { action, error: e.message });
          })
          .finally(() => {
            for (const n of involved) if (!serviceJobs.get(n)?.error) serviceJobs.delete(n);
          });
        return json(res, 202, { ok: true });
      }
    }

    if (resource === 'services' && id === 'restart' && !sub && method === 'POST') {
      // POST /services/restart {names}: stop them (and what needs them), then start back what was running, plus the named ones
      const b = await readBody(req);
      const names = Array.isArray(b.names) ? b.names.map(String) : [];
      if (!names.length) throw new HttpError(400, 'names is required');
      const targets = services.resolve(names);
      for (const n of targets) {
        if (serviceJobs.get(n) && !serviceJobs.get(n)!.error) throw new HttpError(409, `${n} is already ${serviceJobs.get(n)!.action}`);
      }
      for (const n of targets) serviceJobs.set(n, { action: 'restarting' });
      void services
        .restart(targets)
        .catch((e: Error) => {
          for (const n of targets) if (serviceJobs.has(n)) serviceJobs.set(n, { action: 'restarting', error: e.message });
        })
        .finally(() => {
          for (const n of targets) if (!serviceJobs.get(n)?.error) serviceJobs.delete(n);
        });
      return json(res, 202, { ok: true });
    }

    if (resource === 'version' && method === 'GET') return json(res, 200, { stale: isStale() });

    if (resource === 'history' && method === 'DELETE') {
      if (id) {
        if (!history.remove(id)) throw new HttpError(404, `no single history entry matches "${id}"`);
        return json(res, 200, { removed: 1 });
      }
      const repo = url.searchParams.get('repo');
      const path = repo ? (registry.find(repo)?.path ?? repo) : undefined;
      return json(res, 200, { removed: history.clear({ repo: path }) });
    }

    if (resource === 'history' && method === 'GET') {
      const repo = url.searchParams.get('repo');
      const path = repo ? (registry.find(repo)?.path ?? repo) : undefined;
      return json(res, 200, history.list({ repo: path, limit: Number(url.searchParams.get('limit') ?? 100) }));
    }

    if (resource === 'switch' && method === 'POST') {
      const b = await readBody(req);
      const branch = optStr(b.branch)?.trim();
      if (!branch) throw new HttpError(400, 'branch is required');
      if (!Array.isArray(b.repoIds) || b.repoIds.length === 0) throw new HttpError(400, 'repoIds must be a non-empty array');
      const repos = b.repoIds.map((r) => repoOr404(String(r)));
      const clash = repos.find((r) => busy.has(r.path));
      if (clash) throw new HttpError(409, `${clash.name} is already being switched`);
      const batch = new Batch(branch, repos);
      batches.set(batch.id, batch);
      for (const r of repos) busy.add(r.path);
      void batch
        .run(history, optStr(b.base)?.trim() || undefined)
        .finally(() => repos.forEach((r) => busy.delete(r.path)));
      return json(res, 202, { runId: batch.id });
    }

    if (resource === 'runs' && id) {
      const batch = batches.get(id);
      if (!batch) throw new HttpError(404, 'no such run');
      if (sub === 'events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const unsubscribe = batch.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }
      if (sub === 'answer' && method === 'POST') {
        const b = await readBody(req);
        if (typeof b.promptId !== 'string' || typeof b.answer !== 'boolean') throw new HttpError(400, 'promptId and boolean answer required');
        if (!batch.answer(b.promptId, b.answer)) throw new HttpError(409, 'prompt already answered or unknown');
        return json(res, 200, { ok: true });
      }
      if (sub === 'cancel' && method === 'POST') return batch.cancel(), json(res, 200, { ok: true });
      if (!sub && method === 'GET') return json(res, 200, { id: batch.id, branch: batch.branch, done: batch.done, events: batch.events });
    }

    throw new HttpError(404, `no route ${method} ${url.pathname}`);
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    if (!opts.webDir || !existsSync(opts.webDir)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('git-tidy API is running. Build packages/web to get the dashboard.');
      return;
    }
    const root = resolve(opts.webDir);
    let file = normalize(join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const server = createHttpServer(async (req, res) => {
    try {
      // Only accept requests addressed to localhost — blocks DNS-rebinding pages from reaching the API.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'forbidden host');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      // EventSource cannot set headers, so the token may also come as ?token=.
      const presented = req.headers['x-git-tidy-token'] ?? url.searchParams.get('token');
      if (presented !== token) throw new HttpError(401, 'missing or wrong token');
      await api(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof RegistryError || e instanceof PromotionError || e instanceof SettingsError || e instanceof ServiceError ? 400 : 500;
      if (!res.headersSent) json(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  if (opts.pollPromotions !== false) worker.start();
  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    worker,
    isStale,
    close: () =>
      new Promise((ok) => {
        worker.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
