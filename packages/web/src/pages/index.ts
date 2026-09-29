import type { ComponentType } from 'react';
import { ReposPage } from './ReposPage';
import { HistoryPage } from './HistoryPage';

export interface Page {
  id: string;
  label: string;
  component: ComponentType;
}

/** Top-level tabs. A new feature (worktrees, health checks) is one entry here plus its page. */
export const PAGES: Page[] = [
  { id: 'repos', label: 'Repos', component: ReposPage },
  { id: 'history', label: 'History', component: HistoryPage },
];
