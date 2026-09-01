"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export async function createOrgAction(formData: FormData) {
  const name = (formData.get("name") as string).trim();
  const slug = (formData.get("slug") as string).trim().toLowerCase();

  if (!name || name.length < 2 || name.length > 100) {
    redirect("/setup?error=Organization+name+must+be+2–100+characters");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    redirect("/setup?error=Slug+must+be+lowercase+letters,+numbers,+and+hyphens+only");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const service = createServiceRoleClient();

  // Guard: already a member of some org
  const { data: existing } = await service
    .from("organization_members")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) redirect("/dashboard");

  const { data: org, error: orgError } = await service
    .from("organizations")
    .insert({ name, slug })
    .select("id")
    .single();

  if (orgError) {
    const msg =
      orgError.message.includes("unique") || orgError.code === "23505"
        ? "That slug is already taken. Choose another."
        : "Failed to create organization. Please try again.";
    redirect(`/setup?error=${encodeURIComponent(msg)}`);
  }

  const { error: memberError } = await service.from("organization_members").insert({
    organization_id: org.id,
    user_id: user.id,
    role: "super_user",
  });

  if (memberError) {
    redirect("/setup?error=Failed+to+assign+role.+Please+try+again.");
  }

  redirect("/admin/invitations");
}
