import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";
import { createSupabaseServerClient, isSupabaseServerConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST() {
  await clearSessionCookie();
  if (isSupabaseServerConfigured()) {
    try {
      const supabase = await createSupabaseServerClient();
      await supabase.auth.signOut();
    } catch {
      // Non-fatal: dotarc cookie is already cleared.
    }
  }
  return NextResponse.json({ ok: true });
}
