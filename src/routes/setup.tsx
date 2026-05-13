import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { bootstrapPrincipal, checkPrincipalExists } from "@/lib/admin.functions";
import { supabase } from "@/integrations/supabase/client";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/setup")({ component: SetupPage });

function SetupPage() {
  const navigate = useNavigate();
  const checkExists = useServerFn(checkPrincipalExists);
  const bootstrap = useServerFn(bootstrapPrincipal);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    checkExists().then(({ exists }) => {
      setAllowed(!exists);
      if (exists) navigate({ to: "/login" });
    });
  }, [checkExists, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await bootstrap({ data: { full_name: name, email, password } });
      toast.success("Principal account created");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast.error("Created but sign-in failed: " + error.message);
        navigate({ to: "/login" });
      } else {
        navigate({ to: "/principal" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (allowed === null) return <div className="p-10 text-center text-muted-foreground">Checking…</div>;
  if (!allowed) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-primary/10 flex flex-col">
      <header className="px-6 py-5"><Logo /></header>
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <Card className="w-full max-w-md p-8 shadow-lg">
          <h1 className="text-2xl font-bold tracking-tight">Create Principal Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One-time setup. After this, only the Principal can create student accounts.
          </p>
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password (min 8 chars)</Label>
              <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating…" : "Create Principal & Sign In"}
            </Button>
            <Link to="/login" className="block text-center text-xs text-muted-foreground hover:text-foreground">
              Back to login
            </Link>
          </form>
        </Card>
      </main>
    </div>
  );
}
