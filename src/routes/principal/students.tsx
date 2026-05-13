import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PrincipalShell } from "@/components/PrincipalShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createStudent, listStudents, setStudentActive, resetStudentPassword } from "@/lib/admin.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/principal/students")({ component: StudentsPage });

function StudentsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listStudents);
  const create = useServerFn(createStudent);
  const setActive = useServerFn(setStudentActive);
  const resetPwd = useServerFn(resetStudentPassword);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["students"],
    queryFn: async () => (await list()).students,
  });

  const filtered = (data ?? []).filter((s) => {
    const q = search.toLowerCase();
    return !q || s.full_name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q);
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create({ data: form });
      toast.success("Student created");
      setOpen(false);
      setForm({ full_name: "", email: "", password: "" });
      qc.invalidateQueries({ queryKey: ["students"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    try {
      await setActive({ data: { student_id: id, is_active: !isActive } });
      qc.invalidateQueries({ queryKey: ["students"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
  };

  const handleReset = async (id: string) => {
    const pwd = window.prompt("New password (min 6 chars):");
    if (!pwd || pwd.length < 6) return;
    try {
      await resetPwd({ data: { student_id: id, password: pwd } });
      toast.success("Password reset");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
  };

  return (
    <PrincipalShell>
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Students</h1>
          <p className="text-sm text-muted-foreground mt-1">Create and manage student accounts</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Create Student</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Student Account</DialogTitle></DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>Full name</Label>
                <Input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Temporary password (min 6 chars)</Label>
                <Input type="text" required minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <Button type="submit" className="w-full">Create</Button>
            </form>
          </DialogContent>
        </Dialog>
      </header>

      <Card className="p-4 mb-4">
        <Input placeholder="Search by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </Card>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>}
            {filtered.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3 font-medium">{s.full_name}</td>
                <td className="px-4 py-3 text-muted-foreground">{s.email}</td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${s.is_active ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
                    {s.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <Button asChild size="sm" variant="ghost"><Link to="/principal/students/$studentId" params={{ studentId: s.id }}>Profile</Link></Button>
                  <Button size="sm" variant="outline" onClick={() => handleReset(s.id)}>Reset PW</Button>
                  <Button size="sm" variant={s.is_active ? "outline" : "default"} onClick={() => handleToggle(s.id, s.is_active)}>
                    {s.is_active ? "Deactivate" : "Reactivate"}
                  </Button>
                </td>
              </tr>
            ))}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No students yet. Click "Create Student" to add one.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </PrincipalShell>
  );
}
