import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';
import type { Promotion } from './types.js';

interface StoreData {
  version: 1;
  promotions: Promotion[];
}

/** Shared by every process (CLI, dashboard, tray); always re-read before writing. */
export class PromotionStore {
  constructor(readonly file: string = join(configDir(), 'promotions.json')) {}

  private load(): StoreData {
    if (!existsSync(this.file)) return { version: 1, promotions: [] };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      return { version: 1, promotions: data.promotions ?? [] };
    } catch {
      return { version: 1, promotions: [] };
    }
  }

  private save(data: StoreData): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.file);
  }

  /** Newest first. */
  list(): Promotion[] {
    return [...this.load().promotions].reverse();
  }

  get(id: string): Promotion | undefined {
    return this.load().promotions.find((p) => p.id === id || p.id.startsWith(id));
  }

  remove(id: string): boolean {
    const data = this.load();
    const before = data.promotions.length;
    data.promotions = data.promotions.filter((p) => p.id !== id);
    if (data.promotions.length === before) return false;
    this.save(data);
    return true;
  }

  put(promotion: Promotion): void {
    const data = this.load();
    const i = data.promotions.findIndex((p) => p.id === promotion.id);
    if (i === -1) data.promotions.push(promotion);
    else data.promotions[i] = promotion;
    this.save(data);
  }
}
