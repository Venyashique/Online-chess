begin;

-- Database Broadcast is managed by Supabase. Do not publish online_games, which
-- contains credential hashes. Fail closed if the project was configured unsafely.
do $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise exception 'Supabase Database Broadcast realtime.send is required';
  end if;
  if exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'online_games'
  ) then
    raise exception 'online_games must not be in supabase_realtime; review publication before applying 4C';
  end if;
end;
$$;

create function public.notify_online_game_version()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.version <= old.version then return null; end if;
  -- Explicit minimal signal. Never NEW/OLD row JSON, hashes, seat tokens or FEN.
  begin
    perform realtime.send(
      jsonb_build_object('game_id', new.id, 'version', new.version),
      'version_changed', 'online-game:' || new.id::text, false
    );
  exception when others then
    -- Best effort notification must not roll back a valid game mutation.
    -- Reconnect/focus/periodic RPC resync repairs missed signals.
    raise warning 'Online game version notification unavailable';
  end;
  return null;
end;
$$;
revoke all on function public.notify_online_game_version() from public, anon, authenticated;
create trigger online_game_version_broadcast
  after insert or update of version on public.online_games
  for each row execute function public.notify_online_game_version();

comment on function public.notify_online_game_version() is '4C: best-effort public Broadcast of only game_id/version. Never publish online_games row data.';
commit;
