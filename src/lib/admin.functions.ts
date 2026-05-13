import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const principalOnly = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "PRINCIPAL")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: principal role required");
};

// ---------- Bootstrap principal (only works if no principal exists yet) ----------
export const bootstrapPrincipal = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        full_name: z.string().min(1).max(120),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { count, error: cErr } = await supabaseAdmin
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "PRINCIPAL");
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) > 0) {
      throw new Error("A Principal already exists. Sign in instead.");
    }

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    if (error || !created.user) throw new Error(error?.message ?? "Failed to create user");

    // Profile is auto-created by trigger; ensure full_name set
    await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.full_name })
      .eq("id", created.user.id);

    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: created.user.id, role: "PRINCIPAL" });
    if (roleErr) throw new Error(roleErr.message);

    await supabaseAdmin.from("audit_logs").insert({
      user_id: created.user.id,
      action: "Bootstrapped Principal account",
      details: data.email,
    });

    return { ok: true };
  });

export const checkPrincipalExists = createServerFn({ method: "GET" }).handler(async () => {
  const { count, error } = await supabaseAdmin
    .from("user_roles")
    .select("*", { count: "exact", head: true })
    .eq("role", "PRINCIPAL");
  if (error) throw new Error(error.message);
  return { exists: (count ?? 0) > 0 };
});

// ---------- Create student (principal only) ----------
export const createStudent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(6),
        full_name: z.string().min(1).max(120),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await principalOnly(context.userId);

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name, created_by: context.userId },
    });
    if (error || !created.user) throw new Error(error?.message ?? "Failed to create student");

    await supabaseAdmin
      .from("profiles")
      .update({ full_name: data.full_name, created_by: context.userId })
      .eq("id", created.user.id);

    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: created.user.id, role: "STUDENT" });
    if (roleErr) throw new Error(roleErr.message);

    await supabaseAdmin.from("audit_logs").insert({
      user_id: context.userId,
      action: "Created student",
      details: `${data.full_name} <${data.email}>`,
    });

    return { ok: true, user_id: created.user.id };
  });

// ---------- List students (principal only) ----------
export const listStudents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await principalOnly(context.userId);
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, is_active, created_at, last_login_at")
      .in(
        "id",
        (
          await supabaseAdmin.from("user_roles").select("user_id").eq("role", "STUDENT")
        ).data?.map((r) => r.user_id) ?? [],
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { students: data ?? [] };
  });

// ---------- Toggle student active (principal only) ----------
export const setStudentActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ student_id: z.string().uuid(), is_active: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    await principalOnly(context.userId);
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: data.is_active })
      .eq("id", data.student_id);
    if (error) throw new Error(error.message);

    if (!data.is_active) {
      // banned — invalidate sessions
      await supabaseAdmin.auth.admin.updateUserById(data.student_id, { ban_duration: "8760h" });
    } else {
      await supabaseAdmin.auth.admin.updateUserById(data.student_id, { ban_duration: "none" });
    }
    await supabaseAdmin.from("audit_logs").insert({
      user_id: context.userId,
      action: data.is_active ? "Reactivated student" : "Deactivated student",
      details: data.student_id,
    });
    return { ok: true };
  });

// ---------- Reset student password (principal only) ----------
export const resetStudentPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ student_id: z.string().uuid(), password: z.string().min(6) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await principalOnly(context.userId);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.student_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({
      user_id: context.userId,
      action: "Reset student password",
      details: data.student_id,
    });
    return { ok: true };
  });
