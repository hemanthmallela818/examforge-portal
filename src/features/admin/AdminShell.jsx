import { Activity, Database, FileJson, FileText, LayoutDashboard, Library, LogOut, RotateCcw, School, Settings, Shapes, Users } from 'lucide-react';
import { Alert, Button, cn } from '../../components/ui';
import { supabase } from '../../supabase';
import { safeStorageRemove, safeStorageSet } from '../../browserStorage';
import RootAdministratorManager from '../../components/RootAdministratorManager';
import DestructiveActionDialog from '../../components/DestructiveActionDialog';
import { useAdminContext } from './adminContext';
import AdminProfileMenu from './AdminProfileMenu';
import BrandLogo from '../../branding/BrandLogo';
import { useBranding } from '../../branding/brandingStore';

/** @typedef {'brand' | 'danger'} NavTone */
/** @typedef {{ tab: import('./routing/adminRoutes').AdminTab, icon: import('react').ElementType, label: string, tone?: NavTone, rootOnly?: boolean }} NavTabEntry */

/**
 * Sidebar navigation entry for the administrator shell.
 * @param {{ icon: import('react').ElementType, label: string, active: boolean, tone?: NavTone, onClick: () => void }} props
 */
const SidebarNavButton = ({ icon: Icon, label, active, tone = 'brand', onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'flex w-full cursor-pointer items-center gap-3 rounded-lg border-l-[3px] px-3 py-2.5 text-left max-[900px]:w-auto text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400',
      active
        ? tone === 'danger'
          ? 'border-red-500 bg-red-500/15 text-white'
          : 'border-brand-500 bg-brand-600/20 text-white'
        : 'border-transparent text-slate-400 hover:bg-white/5 hover:text-white'
    )}
  >
    <Icon className={cn('admin-nav-icon', active ? (tone === 'danger' ? 'text-red-400' : 'text-brand-300') : 'text-slate-500')} aria-hidden="true" />
    {label}
  </button>
);

/** @type {NavTabEntry[]} */
const ACADEMIC_TABS = [
  { tab: 'STUDENTS', icon: Users, label: 'Students' },
  { tab: 'CLASSES', icon: School, label: 'Classes' },
  { tab: 'SUBJECTS', icon: Shapes, label: 'Subjects & Patterns' },
  { tab: 'QUESTION_BANK', icon: Library, label: 'Question Bank' },
  { tab: 'AI_IMPORTER', icon: FileJson, label: 'Reviewed JSON Import' }
];

/** @type {NavTabEntry[]} */
const SYSTEM_TABS = [
  { tab: 'OPERATIONS', icon: Activity, label: 'Operations & Audit' },
  { tab: 'DB_CLEANER', icon: Database, label: 'Database Cleaner', tone: 'danger' },
  { tab: 'SETTINGS', icon: Settings, label: 'Settings', rootOnly: true }
];

/**
 * Administrator layout: sidebar navigation, top bar with the page title and
 * identity chip, the shared data-load status/retry banner and the
 * destructive-action dialog. The active screen is passed as children.
 * @param {{
 *   activeTab: import('./routing/adminRoutes').AdminTab,
 *   activeExamId: string | null,
 *   pageTitle: string,
 *   onNavigate: (route: { tab: import('./routing/adminRoutes').AdminTab, examId?: string | null }) => void,
 *   onBackToLogin: () => void,
 *   failedDataLoads: Array<[string, import('../../types').DataLoadEntry]>,
 *   isAnyDataLoading: boolean,
 *   onRetryFailedDataLoads: () => void,
 *   children?: import('react').ReactNode
 * }} props
 */
export default function AdminShell({
  activeTab,
  activeExamId,
  pageTitle,
  onNavigate,
  onBackToLogin,
  failedDataLoads,
  isAnyDataLoading,
  onRetryFailedDataLoads,
  children
}) {
  const { isRootDeveloper, destructiveAction, setDestructiveAction } = useAdminContext();
  const { institutionName } = useBranding();

  const renderNavButton = (/** @type {NavTabEntry} */ { tab, icon, label, tone }) => (
    <SidebarNavButton
      key={tab}
      icon={icon}
      label={label}
      tone={tone}
      active={activeTab === tab}
      onClick={() => onNavigate({ tab })}
    />
  );

  return (
    <div className="admin-dashboard-shell">
      <div className="flex h-dvh overflow-hidden bg-slate-50 max-[900px]:h-auto max-[900px]:min-h-dvh max-[900px]:flex-col max-[900px]:overflow-visible">
      {/* Sidebar */}
      <aside className="admin-dashboard-sidebar theme-island z-20 flex w-[280px] shrink-0 flex-col border-r border-white/5 bg-slate-950 text-white">
        <div className="admin-sidebar-brand flex items-center gap-3 border-b border-white/10 px-6 py-6">
          <BrandLogo
            imageClassName="size-10 rounded-xl bg-white p-1"
            tileClassName="size-10 rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-600/30"
            iconClassName="size-[22px]"
          />
          <div className="min-w-0">
            <span className="block text-base font-semibold tracking-tight text-white">Admin Portal</span>
            <p className="truncate text-xs text-slate-400" title={institutionName || undefined}>{institutionName || 'Control Center'}</p>
          </div>
        </div>

        <nav className="admin-sidebar-nav flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-5" aria-label="Administrator sections">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 max-[900px]:hidden">Academics</p>
          <SidebarNavButton
            icon={LayoutDashboard}
            label="Dashboard"
            active={activeTab === 'DASHBOARD' && !activeExamId}
            onClick={() => onNavigate({ tab: 'DASHBOARD' })}
          />

          {activeExamId && (
            <div className="ml-5 flex items-center gap-3 rounded-lg border-l-[3px] border-brand-500 bg-brand-600/20 px-3 py-2.5 text-sm font-medium text-white" aria-current="page">
              <FileText className="admin-nav-icon text-brand-300" aria-hidden="true" /> Exam Detail
            </div>
          )}

          {ACADEMIC_TABS.map(renderNavButton)}

          <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 max-[900px]:hidden">System</p>
          {SYSTEM_TABS.filter(entry => !entry.rootOnly || isRootDeveloper).map(renderNavButton)}
        </nav>

        <div className="admin-sidebar-footer border-t border-white/10 p-4">
          <button
            type="button"
            onClick={async () => {
              safeStorageSet('sessionStorage', 'examState', 'AUTH');
              safeStorageRemove('sessionStorage', 'currentStudent');
              safeStorageRemove('sessionStorage', 'currentAdmin');
              await supabase.auth.signOut({ scope: 'local' }).catch(console.error);
              onBackToLogin();
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-sm font-semibold text-red-400 transition-colors hover:border-red-500 hover:bg-red-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          >
            <LogOut className="admin-nav-icon" aria-hidden="true" /> Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="admin-dashboard-main flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Top bar for main content */}
        <header className="admin-dashboard-topbar sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur lg:px-10">
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-slate-900">
            {pageTitle}
          </h1>
          <AdminProfileMenu isRootDeveloper={isRootDeveloper} />
        </header>

        <div className="admin-dashboard-content mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-6 py-8 lg:px-10">
          {isRootDeveloper && <RootAdministratorManager />}
          {isAnyDataLoading && <p role="status" aria-live="polite" className="sr-only">Refreshing administrator data…</p>}
          {failedDataLoads.length > 0 && (
            <Alert
              variant="danger"
              role="alert"
              title="Some administrator data could not be refreshed."
              action={(
                <Button variant="danger-outline" size="sm" onClick={onRetryFailedDataLoads} disabled={isAnyDataLoading}>
                  <RotateCcw aria-hidden="true" /> Retry failed data
                </Button>
              )}
            >
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {failedDataLoads.map(([key, state]) => <li key={key}>{state.error}</li>)}
              </ul>
            </Alert>
          )}
          {children}
        </div>
      </main>
      </div>
      {destructiveAction && (
        <DestructiveActionDialog
          key={destructiveAction.phrase}
          action={destructiveAction}
          onClose={() => setDestructiveAction(null)}
        />
      )}
    </div>
  );
}
