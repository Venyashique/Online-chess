begin;

create schema online_security;
revoke all on schema online_security from public, anon, authenticated;
-- One centrally configurable policy. No browser-controlled quota values/keys.
create table online_security.policy (
  singleton boolean primary key default true check(singleton),
  create_minute integer not null default 10 check(create_minute > 0),
  create_day integer not null default 100 check(create_day > 0),
  stored_games integer not null default 1000 check(stored_games > 0),
  player_reads_minute integer not null default 120 check(player_reads_minute > 0),
  spectator_reads_minute integer not null default 120 check(spectator_reads_minute > 0),
  moves_minute integer not null default 60 check(moves_minute > 0),
  move_burst integer not null default 4 check(move_burst > 0),
  joins_minute integer not null default 60 check(joins_minute > 0),
  create_attempts_minute integer not null default 120 check(create_attempts_minute > 0),
  join_attempts_minute integer not null default 600 check(join_attempts_minute > 0),
  read_attempts_minute integer not null default 6000 check(read_attempts_minute > 0),
  move_attempts_minute integer not null default 1200 check(move_attempts_minute > 0),
  waiting_seconds integer not null default 86400 check(waiting_seconds > 0),
  joined_seconds integer not null default 604800 check(joined_seconds > 0)
);
insert into online_security.policy default values;
create table online_security.buckets (
  key text primary key,
  game_id uuid references public.online_games(id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null check(hits >= 0)
);
create table online_security.move_bursts (
  game_id uuid references public.online_games(id) on delete cascade,
  color text not null check(color in ('w','b')),
  tokens double precision not null,
  refilled_at timestamptz not null,
  primary key(game_id,color)
);
alter table online_security.policy enable row level security;
alter table online_security.buckets enable row level security;
alter table online_security.move_bursts enable row level security;
revoke all on all tables in schema online_security from public, anon, authenticated;

-- Fixed UTC windows; one stable row per key, never per period/request/token/IP.
create function online_security.check_window(p_key text,p_limit integer,p_seconds integer)
returns integer language sql stable set search_path='' as $$
  select coalesce((select case when b.hits >= p_limit then greatest(1,ceil(extract(epoch from (b.window_start + make_interval(secs=>p_seconds)-statement_timestamp())))::integer) else 0 end
    from online_security.buckets b where b.key=p_key
      and b.window_start=to_timestamp(floor(extract(epoch from statement_timestamp())/p_seconds)*p_seconds)),0);
$$;
create function online_security.take_window(p_key text,p_limit integer,p_seconds integer,p_game uuid default null)
returns integer language plpgsql set search_path='' as $$
declare start_at timestamptz; n integer;
begin
  start_at:=to_timestamp(floor(extract(epoch from statement_timestamp())/p_seconds)*p_seconds);
  insert into online_security.buckets(key,game_id,window_start,hits) values(p_key,p_game,start_at,1)
  on conflict(key) do update set window_start=excluded.window_start,
    hits=case when online_security.buckets.window_start=excluded.window_start then least(online_security.buckets.hits+1,p_limit+1) else 1 end
  returning hits into n;
  if n>p_limit then return greatest(1,ceil(extract(epoch from (start_at+make_interval(secs=>p_seconds)-statement_timestamp())))::integer); end if;
  return 0;
end;
$$;
create function online_security.take_burst(p_game uuid,p_color text,p_rate integer,p_capacity integer)
returns integer language plpgsql set search_path='' as $$
declare b online_security.move_bursts; available double precision; now_at timestamptz;
begin
  insert into online_security.move_bursts values(p_game,p_color,p_capacity,clock_timestamp()) on conflict do nothing;
  select * into b from online_security.move_bursts where game_id=p_game and color=p_color for update;
  -- Sample time AFTER the lock; waiting callers cannot move refilled_at backwards.
  now_at:=clock_timestamp();
  available:=least(p_capacity::double precision,b.tokens+greatest(0,extract(epoch from now_at-b.refilled_at))*p_rate/60.0);
  -- A denied attempt keeps fractional credit; repeated denials must not delay refill.
  update online_security.move_bursts set tokens=case when available>=1 then available-1 else available end,refilled_at=now_at where game_id=p_game and color=p_color;
  if available<1 then return greatest(1,ceil((1-available)*60/p_rate)::integer); end if;
  return 0;
end;
$$;
-- Replaced by retention migration; keeps 004 independently deployable.
create function online_security.expired(p_id uuid)
returns boolean language sql stable set search_path='' as $$ select false; $$;

-- Always call this as a SEPARATE RPC/transaction before work. Return denials,
-- do not RAISE: failed chess validation/mutations cannot roll back attempts.
create function public.online_api_admit(p_operation text,p_id uuid,p_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p online_security.policy; g public.online_games; seat text; wait_for integer; cap integer;
begin
  select * into strict p from online_security.policy where singleton;
  cap:=case p_operation when 'create' then p.create_attempts_minute when 'join' then p.join_attempts_minute when 'read' then p.read_attempts_minute when 'move' then p.move_attempts_minute else null end;
  if cap is null then return jsonb_build_object('code','INVALID_REQUEST'); end if;
  wait_for:=online_security.take_window('attempt:'||p_operation,cap,60);
  if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
  select * into g from public.online_games where id=p_id;
  if p_operation='create' and not found then return jsonb_build_object('code','OK'); end if;
  if g.id is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  if online_security.expired(g.id) then return jsonb_build_object('code','GAME_EXPIRED'); end if;
  seat:=public.online_seat_color(g,p_token);
  if p_operation='create' then
    if seat is distinct from g.creator_color then return jsonb_build_object('code','GAME_EXISTS'); end if;
    wait_for:=online_security.take_window('player:'||g.id||':'||seat,p.player_reads_minute,60,g.id);
    if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
    return jsonb_build_object('code','OK','existing_session',public.online_game_session(g,p_token));
  elsif p_operation='join' then
    if seat is not null then
      wait_for:=online_security.take_window('player:'||g.id||':'||seat,p.player_reads_minute,60,g.id);
      if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
      return jsonb_build_object('code','OK','existing_session',public.online_game_session(g,p_token));
    end if;
    wait_for:=online_security.take_window('join:'||g.id,p.joins_minute,60,g.id);
  elsif p_operation='read' then
    if seat is null then wait_for:=online_security.take_window('spectator:'||g.id,p.spectator_reads_minute,60,g.id);
    else wait_for:=online_security.take_window('player:'||g.id||':'||seat,p.player_reads_minute,60,g.id); end if;
  else
    if seat is null then return jsonb_build_object('code','INVALID_TOKEN'); end if;
    wait_for:=online_security.take_window('move:'||g.id||':'||seat,p.moves_minute,60,g.id);
    wait_for:=greatest(wait_for,online_security.take_burst(g.id,seat,p.moves_minute,p.move_burst));
  end if;
  if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
  return jsonb_build_object('code','OK','session',public.online_game_session(g,p_token));
end;
$$;

-- Called ONLY after server-side CAPTCHA verification, never from browsers.
create function public.online_api_create(p_id uuid,p_color_choice text,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p online_security.policy; g public.online_games; wait_for integer; result jsonb;
begin
  if p_id is null or p_color_choice is null or p_color_choice not in ('white','black','random') or p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('code','INVALID_REQUEST'); end if;
  -- Serialize only successful creation admission: cap/count/idempotency atomic.
  select * into strict p from online_security.policy where singleton for update;
  select * into g from public.online_games where id=p_id;
  if found then
    if online_security.expired(g.id) then return jsonb_build_object('code','GAME_EXPIRED'); end if;
    if public.online_seat_color(g,p_token) is distinct from g.creator_color then return jsonb_build_object('code','GAME_EXISTS'); end if;
    -- Also cover a concurrent duplicate which passed admission before INSERT.
    wait_for:=online_security.take_window('player:'||g.id||':'||g.creator_color,p.player_reads_minute,60,g.id);
    if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
    return jsonb_build_object('code','OK','session',public.online_game_session(g,p_token));
  end if;
  if (select count(*) from public.online_games)>=p.stored_games then return jsonb_build_object('code','CAPACITY_REACHED','retry_after',3600); end if;
  wait_for:=greatest(online_security.check_window('created:minute',p.create_minute,60),online_security.check_window('created:day',p.create_day,86400));
  if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
  result:=public.create_online_game_with_seat(p_id,p_color_choice,p_token);
  if result->>'code'='OK' then
    perform online_security.take_window('created:minute',p.create_minute,60);
    perform online_security.take_window('created:day',p.create_day,86400);
  end if;
  return result;
end;
$$;
create function public.online_api_join(p_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.online_games; seat text; cap integer; wait_for integer;
begin
  select * into g from public.online_games where id=p_id for update;
  if online_security.expired(p_id) then return jsonb_build_object('code','GAME_EXPIRED'); end if;
  -- Cover concurrent joins using the same token; an idempotent join is a read.
  seat:=public.online_seat_color(g,p_token);
  if seat is not null then
    select player_reads_minute into strict cap from online_security.policy where singleton;
    wait_for:=online_security.take_window('player:'||g.id||':'||seat,cap,60,g.id);
    if wait_for>0 then return jsonb_build_object('code','RATE_LIMITED','retry_after',wait_for); end if;
  end if;
  return public.join_online_game(p_id,p_token);
end;
$$;
create function public.online_api_commit_move(p_id uuid,p_token text,p_expected_version integer,p_from text,p_to text,p_promotion text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.online_games where id=p_id for update;
  if online_security.expired(p_id) then return jsonb_build_object('code','GAME_EXPIRED'); end if;
  return public.commit_online_move(p_id,p_token,p_expected_version,p_from,p_to,p_promotion);
end;
$$;
revoke all on all functions in schema online_security from public, anon, authenticated;
revoke all on function public.online_api_admit(text,uuid,text),public.online_api_create(uuid,text,text),public.online_api_join(uuid,text),public.online_api_commit_move(uuid,text,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.online_api_admit(text,uuid,text),public.online_api_create(uuid,text,text),public.online_api_join(uuid,text),public.online_api_commit_move(uuid,text,integer,text,text,text) to service_role;
-- Deliberately NO changes to legacy RPC grants until migration 006.
commit;
