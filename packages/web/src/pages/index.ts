import type { ComponentType } from 'react';
import { ReposPage } from './ReposPage';
import { HistoryPage } from './HistoryPage';
import { ServicesPage } from './ServicesPage';
import { PromotionsPage } from './PromotionsPage';

export interface Page {
  id: string;
  label: string;
  component: ComponentType;
}

/** Top-level tabs. A new feature (worktrees, health checks) is one entry here plus its page. */
export const PAGES: Page[] = [
  { id: 'repos', label: 'Repos', component: ReposPage },
  { id: 'promotions', label: 'Promotions', component: PromotionsPage },
  { id: 'services', label: 'Services', component: ServicesPage },
  { id: 'history', label: 'History', component: HistoryPage },
];
