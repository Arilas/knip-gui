// Primary nav (Task 1, UX overhaul): Dashboard/Code/Packages/Ignored/Activity,
// lucide icons + count badges (Ignored/Activity are badge-less — nothing to
// count yet, they land in Task 5), active state from the ui store. Icon-
// collapsible inset sidebar per the design spec; header hosts
// WorkspaceSwitcher, footer hosts GitFooter. Replaces TopBar + FacetRail
// (both deleted this task).
import type { ComponentType } from 'react';
import { EyeOff, FileCode2, History, LayoutDashboard, Package } from 'lucide-react';
import type { Issue } from '../../../../src/core/types.js';
import { CODE_TYPES, PACKAGE_TYPES, useUiStore, type Page } from '../../state/ui.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../ui/sidebar.js';
import { GitFooter } from './GitFooter.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

export interface AppSidebarProps {
  issues: Issue[];
  workspaces: string[];
}

const CODE_TYPE_SET = new Set(CODE_TYPES);
const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);

interface NavItem {
  page: Page;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
}

export function AppSidebar({ issues, workspaces }: AppSidebarProps) {
  const page = useUiStore((s) => s.page);
  const navigate = useUiStore((s) => s.navigate);

  const codeCount = issues.filter((i) => CODE_TYPE_SET.has(i.type)).length;
  const packagesCount = issues.filter((i) => PACKAGE_TYPE_SET.has(i.type)).length;

  const items: NavItem[] = [
    { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, count: issues.length },
    { page: 'code', label: 'Code', icon: FileCode2, count: codeCount },
    { page: 'packages', label: 'Packages', icon: Package, count: packagesCount },
    { page: 'ignored', label: 'Ignored', icon: EyeOff },
    { page: 'activity', label: 'Activity', icon: History },
  ];

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <WorkspaceSwitcher workspaces={workspaces} issues={issues} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.page}>
              <SidebarMenuButton
                data-testid={`nav-${item.page}`}
                isActive={page === item.page}
                aria-current={page === item.page ? 'page' : undefined}
                tooltip={item.label}
                onClick={() => navigate(item.page)}
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </SidebarMenuButton>
              {item.count !== undefined && <SidebarMenuBadge>{item.count}</SidebarMenuBadge>}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <GitFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
