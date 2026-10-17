begin;
alter table public.online_games add column expires_at timestamptz;
-- Existing games get a full grace period, independent of their old timestamps.
update public.online_games set expires_at=statement_timestamp()+make_interval(secs=>(select joined_seconds from online_security.policy where singleton));
alter table public.online_games alter column expires_at set not null;
create index online_games_expiry_idx on public.online_games(expires_at);
create or replace function online_security.expired(p_id uuid)
returns boolean language sql volatile set search_path='' as $$
  -- statement_timestamp() predates row-lock waits and can revive expired games.
  select coalesce((select expires_at<=clock_timestamp() from public.online_games where id=p_id),false);
$$;
create function online_security.apply_retention()
returns trigger language plpgsql security definer set search_path='' as $$
declare seconds integer; now_at timestamptz:=clock_timestamp();
begin
  if tg_op='UPDATE' then
    if new.version<=old.version then return new; end if;
    if old.expires_at<=now_at then raise exception 'Game expired' using errcode='P0001'; end if;
  end if;
  select case when new.opponent_joined_at is null then waiting_seconds else joined_seconds end into strict seconds from online_security.policy where singleton;
  new.expires_at:=now_at+make_interval(secs=>seconds);
  return new;
end;
$$;
create trigger online_game_retention before insert or update of version on public.online_games for each row execute function online_security.apply_retention();
revoke all on function online_security.apply_retention() from public,anon,authenticated;
-- Safe preview ONLY. No DELETE, no boolean switch to enable it, no cron job.
create function public.online_cleanup_preview(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids jsonb; total bigint;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then raise exception 'Invalid preview limit' using errcode='22023'; end if;
  select count(*) into total from public.online_games where expires_at<=statement_timestamp();
  select coalesce(jsonb_agg(id),'[]'::jsonb) into ids from (select id from public.online_games where expires_at<=statement_timestamp() order by expires_at,id limit p_limit) q;
  return jsonb_build_object('dry_run',true,'total_expired',total,'sample_ids',ids,'sample_limit',p_limit);
end;
$$;
revoke all on function public.online_cleanup_preview(integer) from public,anon,authenticated;
grant execute on function public.online_cleanup_preview(integer) to service_role;
commit;
