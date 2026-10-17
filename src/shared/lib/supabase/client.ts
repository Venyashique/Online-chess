import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

type SupabaseEnvironment = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
};

export function createBrowserSupabaseClient(
  env: SupabaseEnvironment = import.meta.env,
) {
  const configuredUrl = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!configuredUrl || !key) return null;
  let url: string;
  try {
    const parsed = new URL(configuredUrl);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !["/", "", "/rest/v1", "/rest/v1/"].includes(parsed.pathname)
    )
      return null;
    // The dashboard's Data API URL includes /rest/v1. The SDK needs the
    // project root to build REST, Functions and Realtime endpoints itself.
    // Accept only this exact suffix; never guess a different host or path.
    url = parsed.origin;
  } catch {
    return null;
  }
  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
