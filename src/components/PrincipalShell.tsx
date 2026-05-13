import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, FileText, BookOpen, Users, BarChart3, Activity, ScrollText, LogOut, Library } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useEffect, type ReactNode } from "react";

const NAV = [
  { to: "/principal", label: "Dashboard", icon: LayoutDashboard },
  { to: "/principal/exams", label: "Exams", icon: FileText },
  { to: "/principal/questions", label: "Question Bank", icon: Library },
  { to: "/principal/subjects", label: "Subjects", icon: BookOpen },
  { to: "/principal/students", label: "Students", icon: Users },
  { to: "/principal/results", label: "Results & Analytics", icon: BarChart3 },
  { to: "/principal/monitor", label: "Live Monitor", icon: Activity },
  { to: "/principal/audit", label: "Audit Logs", icon: ScrollText },
];

export function PrincipalShell({ children }: { children: ReactNode }) {
  const { user, role, loading, fullName, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (role && role !== "PRINCIPAL") navigate({ to: "/student" });
  }, [user, role, loading, navigate]);

  if (loading || !user || role !== "PRINCIPAL") {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex min-h-screen w-full bg-muted/30">
      <aside className="hidden md:flex w-64 flex-col bg-sidebar text-sidebar-foreground">
        <div className="px-5 py-5 border-b border-sidebar-border">
          <Logo />
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV.map((item) => {
            const active = pathname === item.to || (item.to !== "/principal" && pathname.startsWith(item.to));
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border px-4 py-4">
          <div className="text-xs text-sidebar-foreground/70">Signed in as</div>
          <div className="text-sm font-medium truncate">{fullName ?? user.email}</div>
          <Button variant="ghost" size="sm" className="mt-3 w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground" onClick={() => { signOut(); navigate({ to: "/login" }); }}>
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="mx-auto w-full max-w-7xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
