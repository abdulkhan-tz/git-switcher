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
  /** Inline SVG path data (24x24 viewBox, stroked). */
  icon: string;
  component: ComponentType;
}

/** Top-level tabs. A new feature (worktrees, health checks) is one entry here plus its page. */
export const PAGES: Page[] = [
  { id: 'repos', section: 'Git', label: 'Repos', icon: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a9 9 0 0 1-9 9', component: ReposPage },
  { id: 'promotions', section: 'Git', label: 'Promotions', icon: 'M12 19V5M5 12l7-7 7 7', component: PromotionsPage },
  { id: 'history', section: 'Git', label: 'History', icon: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2', component: HistoryPage },
  { id: 'services', section: 'Services', label: 'Services', icon: 'M4 6h16M4 12h16M4 18h16M8 6v0M8 12v0M8 18v0', component: ServicesPage },
  { id: 'groups', section: 'Services', label: 'Groups', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', component: GroupsPage },
];
