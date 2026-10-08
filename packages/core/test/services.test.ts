import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceError, ServiceManager, ServiceStore, portOpen, validateDef, type ServiceDef, type ServiceEvent } from '../src/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'git-tidy-svc-'));
  const manager = new ServiceManager(new ServiceStore(join(dir, 'services.json')));
  cleanup.push(() => manager.down([]));
  return { dir, manager };
}

/** A service that just listens on its port. */
const listener = (name: string, port: number, extra: Partial<ServiceDef> = {}): ServiceDef =>
  validateDef({ name, cwd: tmpdir(), port, command: `exec node -e "require('net').createServer().listen(${port}, '127.0.0.1')"`, startTimeoutSec: 20, ...extra });

describe('services', () => {
  it('starts in dependency order, reports state, and stops dependents first', async () => {
    const { manager } = setup();
    const [a, b] = [await freePort(), await freePort()];
    manager.store.put(listener('db', a));
    manager.store.put(listener('app', b, { dependsOn: ['db'] }));

    const events: ServiceEvent[] = [];
    await manager.up(['app'], (e) => events.push(e));
    expect(events.filter((e) => e.type === 'ready').map((e) => e.name)).toEqual(['db', 'app']);
    expect((await manager.status()).map((s) => s.state)).toEqual(['up', 'up']);

    const stopped: string[] = [];
    await manager.down(['db'], (e) => e.type === 'stopped' && stopped.push(e.name));
    expect(stopped).toEqual(['app', 'db']); // stopping db also stops what needs it, app first
    expect((await manager.status()).map((s) => s.state)).toEqual(['down', 'down']);
  }, 30_000);

  it('leaves a service something else started alone unless told to stop it, then can take it over', async () => {
    const { manager } = setup();
    const port = await freePort();
    // started "elsewhere": a separate process in its own group, as an IDE or terminal would
    const outside = spawn('node', ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`], { detached: true, stdio: 'ignore' });
    cleanup.push(async () => void outside.kill());
    manager.store.put(listener('web', port));
    for (let i = 0; i < 40 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));

    const events: ServiceEvent[] = [];
    await manager.up([], (e) => events.push(e));
    expect(events).toEqual([expect.objectContaining({ type: 'skip', name: 'web' })]);
    const [st] = await manager.status('web');
    expect(st).toMatchObject({ state: 'external', externalPid: outside.pid });
    expect(st!.externalCommand).toContain('node');

    await manager.down([], (e) => events.push(e)); // no opt-in: untouched
    expect((await manager.status('web'))[0]!.state).toBe('external');

    await manager.down(['web'], (e) => events.push(e), { external: true });
    expect(events.at(-1)).toEqual({ type: 'stopped', name: 'web', external: true });
    expect((await manager.status('web'))[0]!.state).toBe('down');

    await manager.up(['web']); // now owned by the manager
    expect((await manager.status('web'))[0]!.state).toBe('up');
  }, 30_000);

  it('fails clearly when the process exits before opening its port, or prepare fails', async () => {
    const { manager } = setup();
    manager.store.put(validateDef({ name: 'crash', cwd: tmpdir(), port: await freePort(), command: 'echo boom; exit 3' }));
    await expect(manager.up(['crash'])).rejects.toThrow(/exited before it opened port/);
    expect(manager.tail('crash')).toContain('boom');

    manager.store.put(validateDef({ name: 'bad-prep', cwd: tmpdir(), port: await freePort(), prepare: 'exit 4', command: 'exec sleep 60' }));
    await expect(manager.up(['bad-prep'])).rejects.toThrow(/prepare step failed \(exit 4\)/);
    expect((await manager.status('bad-prep'))[0]!.state).toBe('down');
  });

  it('rejects bad definitions, unknown names and dependency cycles', () => {
    const { manager } = setup();
    expect(() => validateDef({ name: 'x y', cwd: '/', command: 'true', port: 1 })).toThrow(ServiceError);
    expect(() => validateDef({ name: 'x', cwd: '/', command: 'true', port: 70000 })).toThrow(/port/);
    expect(() => manager.store.get('nope')).toThrow(/no service/);
    manager.store.put(listener('a', 1, { dependsOn: ['b'] }));
    manager.store.put(listener('b', 2, { dependsOn: ['a'] }));
    expect(() => manager.order(['a'])).toThrow(/cycle/);
    manager.store.update('a', { dependsOn: null });
    manager.store.remove('b');
    manager.store.remove('a'); // the shared teardown stops everything, which a cycle would break
  });

  it('leaves a dependency that is already up alone, and restart brings back what it stopped', async () => {
    const { manager } = setup();
    const [a, b] = [await freePort(), await freePort()];
    manager.store.put(listener('db', a));
    manager.store.put(listener('app', b, { dependsOn: ['db'] }));
    await manager.up(['db']);
    const dbPid = (await manager.status('db'))[0]!.pid;

    const events: ServiceEvent[] = [];
    await manager.up(['app'], (e) => events.push(e));
    expect(events.filter((e) => e.type === 'start').map((e) => e.name)).toEqual(['app']); // db was not started again
    expect((await manager.status('db'))[0]!.pid).toBe(dbPid);

    await manager.restart(['app']); // restarting app must not touch its dependency
    expect((await manager.status('db'))[0]!.pid).toBe(dbPid);

    const appPid = (await manager.status('app'))[0]!.pid;
    await manager.restart(['db']); // stops app too, so app has to come back
    const after = await manager.status();
    expect(after.map((x) => x.state)).toEqual(['up', 'up']);
    expect(after[0]!.pid).not.toBe(dbPid);
    expect(after[1]!.pid).not.toBe(appPid);
  }, 60_000);

  it('starts a group in its sequence, pulling in dependencies first', async () => {
    const { manager } = setup();
    const [a, b, c] = [await freePort(), await freePort(), await freePort()];
    manager.store.put(listener('one', a));
    manager.store.put(listener('two', b));
    manager.store.put(listener('three', c, { dependsOn: ['one'] }));
    manager.store.setGroup('stack', ['two', 'three']);

    const ready: string[] = [];
    await manager.up(['stack'], (e) => e.type === 'ready' && ready.push(e.name));
    expect(ready).toEqual(['two', 'one', 'three']); // sequence, with three's dependency ahead of it

    const stopped: string[] = [];
    await manager.down(['stack'], (e) => e.type === 'stopped' && stopped.push(e.name));
    expect(stopped).toEqual(['three', 'two']); // reverse, members only: 'one' was just a dependency
    expect((await manager.status('one'))[0]!.state).toBe('up');
  }, 60_000);

  it('renames everywhere, edits fields, and guards group and service names', () => {
    const { manager } = setup();
    manager.store.put(listener('db', 1));
    manager.store.put(listener('app', 2, { dependsOn: ['db'] }));
    manager.store.setGroup('all-of-it', ['db', 'app']);

    manager.store.rename('db', 'database');
    expect(manager.store.get('app').dependsOn).toEqual(['database']);
    expect(manager.store.groups()[0]!.members).toEqual(['database', 'app']);
    expect(() => manager.store.rename('app', 'database')).toThrow(/already in use/);
    expect(() => manager.store.rename('app', 'all-of-it')).toThrow(/already in use/);
    expect(() => manager.store.rename('app', 'up')).toThrow(/reserved/);
    expect(() => manager.store.setGroup('app', ['database'])).toThrow(/already a service/);
    expect(() => manager.store.setGroup('g', ['nope'])).toThrow(/no such service/);
    expect(() => manager.store.remove('database')).toThrow(/depends on database/);

    manager.store.update('app', { prepare: 'true', startTimeoutSec: 30, port: 9 });
    expect(manager.store.get('app')).toMatchObject({ prepare: 'true', startTimeoutSec: 30, port: 9 });
    manager.store.update('app', { prepare: null, startTimeoutSec: null });
    expect(manager.store.get('app').prepare).toBeUndefined();
    expect(manager.store.get('app').startTimeoutSec).toBeUndefined();

    manager.store.remove('app');
    expect(manager.store.groups()[0]!.members).toEqual(['database']);
  });
});
