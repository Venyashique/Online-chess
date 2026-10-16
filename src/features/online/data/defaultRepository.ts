import { createBrowserSupabaseClient } from "../../../shared/lib/supabase/client";
import { SupabaseOnlineGameRepository } from "./SupabaseOnlineGameRepository";

const client = createBrowserSupabaseClient();
export const defaultOnlineRepository = client
  ? new SupabaseOnlineGameRepository(client)
  : null;
