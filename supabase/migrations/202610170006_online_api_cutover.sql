begin;
-- FINAL CUTOVER ONLY: deploy the limited Edge API and new client first.
-- Old tabs need reload; UUIDs, tokens and Realtime 4C are unchanged.
revoke all on function public.create_online_game(text),public.create_online_game_with_seat(uuid,text,text),public.get_online_game(uuid),public.get_online_game_session(uuid,text),public.join_online_game(uuid,text) from public,anon,authenticated;
-- Commit remains server-only. No direct-table access or publication changes.
revoke all on function public.commit_online_move(uuid,text,integer,text,text,text) from public,anon,authenticated;
revoke all on table public.online_games from public,anon,authenticated;
alter table public.online_games enable row level security;
commit;
