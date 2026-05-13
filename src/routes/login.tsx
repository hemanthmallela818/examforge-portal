import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { checkPrincipalExists } from "@/lib/admin.functions";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const { user, role, loading: authLoading, refresh } = useAuth();
  const checkExists = useServerFn(checkPrincipalExists);
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    checkExists().then(({ exists }) => setNeedsBootstrap(!exists)).catch(() => setNeedsBootstrap(false));
  }, [checkExists]);

  useEffect(() => {
    if (authLoading) return;
    if (user && role === "PRINCIPAL") navigate({ to: "/principal" });
    if (user && role === "STUDENT") navigate({ to: "/student" });
  }, [user, role, authLoading, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast.error(error.message || "Invalid credentials");
      } else {
        await refresh();
        toast.success("Signed in");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-primary/10 flex flex-col">
      <header className="px-6 py-5">
        <Logo />
      </header>
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <Card className="w-full max-w-md p-8 shadow-lg">
          <h1 className="text-2xl font-bold tracking-tight">Sign in to ExamForge</h1>
          <p className="mt-1 text-sm text-muted-foreground">Use your institution-issued credentials.</p>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Signing in…" : "Login"}
            </Button>
          </form>

          <p className="mt-6 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            Student accounts are created by your institution's Principal. Contact your Principal if you do not have login credentials.
          </p>

          {needsBootstrap && (
            <div className="mt-4 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
              <p className="font-medium text-warning">First-time setup</p>
              <p className="mt-1 text-muted-foreground">
                No Principal account exists yet.{" "}
                <Link to="/setup" className="font-medium text-primary underline">Set up the Principal account</Link>.
              </p>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
