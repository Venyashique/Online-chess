import { createClient } from "@supabase/supabase-js";
import { createSubmitMoveHandler } from "./handler.ts";

// These variables are injected by Supabase into the Edge runtime. Never VITE_*.
const url = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey)
  throw new Error("Missing server-side Supabase configuration");
const client = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createSubmitMoveHandler({
    async getSession(id, token) {
      const { data, error } = await client.rpc("get_online_game_session", {
        p_id: id,
        p_token: token,
      });
      if (error) throw new Error("Read failed");
      return data;
    },
    async commitMove(command) {
      const { data, error } = await client.rpc("commit_online_move", {
        p_id: command.gameId,
        p_token: command.token,
        p_expected_version: command.expectedVersion,
        p_from: command.from,
        p_to: command.to,
        p_promotion: command.promotion ?? null,
      });
      if (error) throw new Error("Commit failed");
      return data;
    },
  }),
);
