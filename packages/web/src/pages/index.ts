import type { ComponentType } from 'react';
import { ReposPage } from './ReposPage';
import { HistoryPage } from './HistoryPage';
import { ServicesPage } from './ServicesPage';
import { GroupsPage } from './GroupsPage';
import { PromotionsPage } from './PromotionsPage';

export interface Page {
  id: string;
  /** Which half of the app: git chores, or the local processes. The header groups tabs by it. */
  section: 'Git' | 'Services';
  label: string;
  component: ComponentType;
}

/** Top-level tabs. A new feature (worktrees, health checks) is one entry here plus its page. */
export const PAGES: Page[] = [
  { id: 'repos', section: 'Git', label: 'Repos', component: ReposPage },
  { id: 'promotions', section: 'Git', label: 'Promotions', component: PromotionsPage },
  { id: 'history', section: 'Git', label: 'History', component: HistoryPage },
  { id: 'services', section: 'Services', label: 'Services', component: ServicesPage },
  { id: 'groups', section: 'Services', label: 'Groups', component: GroupsPage },
];
