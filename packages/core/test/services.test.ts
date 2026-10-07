import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceError, ServiceManager, ServiceStore, validateDef, type ServiceDef, type ServiceEvent } from '../src/index.js';

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

  it('skips a service that something else already started and never stops it', async () => {
    const { manager } = setup();
    const port = await freePort();
    const outside = createServer().listen(port, '127.0.0.1');
    cleanup.push(() => new Promise((ok) => outside.close(() => ok())));
    manager.store.put(listener('web', port));

    const events: ServiceEvent[] = [];
    await manager.up([], (e) => events.push(e));
    expect(events).toEqual([expect.objectContaining({ type: 'skip', name: 'web' })]);
    expect((await manager.status('web'))[0]!.state).toBe('external');

    await manager.down([], (e) => events.push(e));
    expect(await manager.status('web').then((s) => s[0]!.state)).toBe('external');
  });

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
    manager.store.remove('a');
    manager.store.remove('b'); // the shared teardown stops everything, which a cycle would break
  });
});
