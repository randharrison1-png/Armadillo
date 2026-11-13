'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  FileClock,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Settings,
  Shield,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { signOut } from '@/server/auth/actions';
import { getWorkspaceStore } from '@/features/workspace/store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ScriptCategory } from '@/lib/types';

export const SIDEBAR_STORAGE_KEY = 'armadillo.sidebar.collapsed';

export type SidebarSession = { id: string; title: string };
export type LibraryCounts = Partial<Record<ScriptCategory, number>>;

type Props = {
  userEmail: string;
  sessions?: SidebarSession[];
  libraryCounts?: LibraryCounts;
};

const LIBRARY_CHILDREN: { category: ScriptCategory; label: string }[] = [
  { category: 'windows', label: 'Windows' },
  { category: 'windows_server', label: 'Windows Server' },
  { category: 'linux', label: 'Linux' },
  { category: 'leads_audit', label: 'LEADS/Audit' },
];

const rowClass =
  'flex h-10 w-full items-center gap-2 rounded-sm px-2 text-small transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60';
const idle = 'text-muted hover:bg-surface-raised hover:text-text';
const active = 'bg-accent text-accent-ink';

function matches(pathname: string, href: string, exact = false) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function sessionIdFrom(pathname: string): string | null {
  const m = /^\/app\/sessions\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export function Sidebar({ userEmail, sessions = [], libraryCounts = {} }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount (SSR renders expanded)
      if (window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1') setCollapsed(true);
    } catch {
      // Storage unavailable: stay expanded.
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, c ? '0' : '1');
      } catch {
        // Not persisted; still toggles for this page view.
      }
      return !c;
    });
  };

  const currentSessionId = sessionIdFrom(pathname);

  const withTip = (label: string, node: React.ReactElement) =>
    collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    ) : (
      node
    );

  const label = (text: string) => <span className={cn('truncate', collapsed && 'sr-only')}>{text}</span>;

  const navLink = (href: string, text: string, Icon: LucideIcon, isActive: boolean) =>
    withTip(
      text,
      <Link
        href={href}
        aria-current={isActive ? 'page' : undefined}
        className={cn(rowClass, collapsed && 'justify-center', isActive ? active : idle)}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        {label(text)}
      </Link>,
    );

  const nested = (items: { key: string; href: string; label: string; isActive: boolean }[]) =>
    !collapsed && items.length > 0 ? (
      <ul className="ml-4 flex flex-col gap-1 border-l border-border pl-2">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              aria-current={i.isActive ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center rounded-sm px-2 text-small transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                i.isActive ? active : idle,
              )}
            >
              <span className="truncate">{i.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    ) : null;

  const flowchartLabel = 'Hardening Flowchart';
  const flowchart = currentSessionId ? (
    withTip(
      flowchartLabel,
      <button
        type="button"
        className={cn(rowClass, collapsed && 'justify-center', idle)}
        onClick={() =>
          getWorkspaceStore(currentSessionId).getState().openTab({ key: 'flowchart', kind: 'flowchart', title: 'Flowchart' })
        }
      >
        <GitBranch aria-hidden className="size-4 shrink-0" />
        {label(flowchartLabel)}
      </button>,
    )
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Wrapper span keeps the tooltip reachable: disabled buttons do not fire pointer/focus events. */}
        <span tabIndex={0} className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <button type="button" disabled tabIndex={-1} className={cn(rowClass, collapsed && 'justify-center', idle)}>
            <GitBranch aria-hidden className="size-4 shrink-0" />
            {label(flowchartLabel)}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">Open a session first</TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        data-testid="sidebar"
        data-collapsed={collapsed}
        className={cn(
          'flex h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <div className={cn('flex h-12 items-center border-b border-border px-2', collapsed ? 'justify-center' : 'justify-between')}>
          <div className="flex items-center gap-2 px-2">
            <Shield aria-hidden className="size-5 shrink-0 text-accent" />
            {collapsed ? null : <span className="text-body font-semibold text-text">Armadillo</span>}
          </div>
          {collapsed ? null : (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={toggle}
              className="flex size-8 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronsLeft aria-hidden className="size-4" />
            </button>
          )}
        </div>

        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {navLink('/app', 'Dashboard', LayoutDashboard, matches(pathname, '/app', true))}
          {navLink('/app/sessions', 'Sessions', FolderKanban, matches(pathname, '/app/sessions') && !currentSessionId)}
          {nested(
            sessions.map((s) => ({
              key: s.id,
              href: `/app/sessions/${s.id}`,
              label: s.title,
              isActive: s.id === currentSessionId,
            })),
          )}
          {navLink('/app/library', 'Script Library', BookOpen, matches(pathname, '/app/library'))}
          {nested(
            LIBRARY_CHILDREN.map((c) => ({
              key: c.category,
              href: `/app/library?category=${c.category}`,
              label: `${c.label} (${libraryCounts[c.category] ?? 0})`,
              isActive: false,
            })),
          )}
          {navLink('/p', 'Public Pastebin', Globe, matches(pathname, '/p'))}
          {flowchart}
          {navLink('/app/reports', 'Sessions & Reports', FileClock, matches(pathname, '/app/reports'))}
          {navLink('/app/settings', 'Settings', Settings, matches(pathname, '/app/settings'))}
        </nav>

        <div className="flex flex-col gap-1 border-t border-border p-2">
          {collapsed ? (
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={toggle}
              className={cn(rowClass, 'justify-center', idle)}
            >
              <ChevronsRight aria-hidden className="size-4" />
            </button>
          ) : null}
          <form action={signOut} className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'px-2')}>
            {collapsed ? null : (
              <span className="min-w-0 flex-1 truncate text-small text-muted" title={userEmail}>
                {userEmail}
              </span>
            )}
            {withTip(
              'Sign out',
              <button
                type="submit"
                aria-label="Sign out"
                className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <LogOut aria-hidden className="size-4" />
              </button>,
            )}
          </form>
        </div>
      </div>
    </TooltipProvider>
  );
}
