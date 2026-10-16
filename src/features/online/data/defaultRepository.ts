import { SupabaseOnlineRealtimeClient } from "../realtime/SupabaseOnlineRealtimeClient";
import { createBrowserSupabaseClient } from "../../../shared/lib/supabase/client";
import { SupabaseOnlineGameRepository } from "./SupabaseOnlineGameRepository";

const client = createBrowserSupabaseClient();
export const defaultOnlineRepository = client
  ? new SupabaseOnlineGameRepository(client)
  : null;

export const defaultOnlineRealtime = client ? new SupabaseOnlineRealtimeClient(client) : null;
