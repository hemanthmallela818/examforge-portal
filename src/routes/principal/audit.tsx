import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/principal/audit")({ component: AuditPage });

function AuditPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: async () => (await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200)).data ?? [],
  });
  return (
    <PrincipalShell>
      <h1 className="text-3xl font-bold tracking-tight mb-6">Audit Logs</h1>
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-4 py-3">When</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Details</th></tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>}
            {data?.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 font-medium">{l.action}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.details}</td>
              </tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">No log entries yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}
