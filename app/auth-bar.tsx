"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  email: string | null;
  display_name: string | null;
  role: string;
};

export function AuthBar() {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    async function loadProfile() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;

      const { data } = await supabase
        .from("app_profiles")
        .select("email, display_name, role")
        .eq("id", userData.user.id)
        .maybeSingle();

      setProfile(data ?? {
        email: userData.user.email ?? null,
        display_name: null,
        role: "unknown",
      });
    }

    void loadProfile();
  }, [supabase]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="authbar">
      <span>{profile?.display_name || profile?.email || "Signed in"}</span>
      <strong>{profile?.role || "loading"}</strong>
      <button onClick={logout}>Logout</button>
    </div>
  );
}
