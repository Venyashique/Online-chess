begin;
-- Apply explicitly AFTER 004/005, BEFORE deploying the replay-aware online-api.
-- Does not apply/depend on 006; legacy public RPC cutover remains separate.
alter table online_security.policy
  add column turnstile_ttl_seconds integer not null default 600 check(turnstile_ttl_seconds between 600 and 3600),
  add column turnstile_capacity integer not null default 2048 check(turnstile_capacity between 1 and 100000),
  add column turnstile_cleanup_batch integer not null default 128 check(turnstile_cleanup_batch between 1 and 1000),
  add column turnstile_max_age_seconds integer not null default 240 check(turnstile_max_age_seconds between 1 and 240),
  add column turnstile_future_skew_seconds integer not null default 30 check(turnstile_future_skew_seconds between 0 and 30);

create table online_security.turnstile_uses (
  token_hash bytea primary key check(octet_length(token_hash)=32),
  reservation_id uuid not null unique default gen_random_uuid(),
  game_id uuid not null,
  player_token_hash bytea not null check(octet_length(player_token_hash)=32),
  reserved_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check(expires_at >= reserved_at + interval '600 seconds')
);
-- Deliberately no FK to games: deletion/rollback of a game must not release proof.
create index turnstile_uses_expiry_idx on online_security.turnstile_uses(expires_at,token_hash);
alter table online_security.turnstile_uses enable row level security;
revoke all on online_security.turnstile_uses from public,anon,authenticated,service_role;

create function public.online_api_reserve_turnstile(p_hash text,p_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p online_security.policy; now_at timestamptz; reservation uuid;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_REQUEST');
  end if;
  -- All registry cleanup/reservation/finalization use the same lock FIRST.
  perform pg_advisory_xact_lock(170007,1);
  select * into strict p from online_security.policy where singleton;
  now_at:=clock_timestamp();
  delete from online_security.turnstile_uses where token_hash in
    (select token_hash from online_security.turnstile_uses where expires_at<=now_at order by expires_at,token_hash limit p.turnstile_cleanup_batch);
  if exists(select 1 from online_security.turnstile_uses where token_hash=decode(p_hash,'hex')) then
    return jsonb_build_object('code','CAPTCHA_INVALID');
  end if;
  if (select count(*) from online_security.turnstile_uses)>=p.turnstile_capacity then
    return jsonb_build_object('code','UNAVAILABLE');
  end if;
  insert into online_security.turnstile_uses(token_hash,game_id,player_token_hash,reserved_at,expires_at)
    values(decode(p_hash,'hex'),p_id,sha256(convert_to(p_token,'UTF8')),now_at,now_at+make_interval(secs=>p.turnstile_ttl_seconds)) returning reservation_id into reservation;
  return jsonb_build_object('code','OK','reservation_id',reservation);
end;
$$;

-- Preserve the reviewed creation/quota implementation as an owner-only helper.
-- Neither old Edge instances nor service-role callers can invoke it directly.
alter function public.online_api_create(uuid,text,text) set schema online_security;
alter function online_security.online_api_create(uuid,text,text) rename to create_game_unchecked;
revoke all on function online_security.create_game_unchecked(uuid,text,text) from public,anon,authenticated,service_role;
create function public.online_api_create(p_id uuid,p_color_choice text,p_token text)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('code','UNAVAILABLE');
$$;

create function public.online_api_create_reserved(p_id uuid,p_color_choice text,p_token text,p_reservation uuid,p_challenge_ts timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p online_security.policy; r online_security.turnstile_uses; now_at timestamptz; result jsonb;
begin
  if p_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_reservation is null or p_challenge_ts is null or not isfinite(p_challenge_ts) then
    return jsonb_build_object('code','CAPTCHA_INVALID');
  end if;
  perform pg_advisory_xact_lock(170007,1);
  -- Same lock order as creation: registry -> policy -> reservation -> game.
  select * into strict p from online_security.policy where singleton for update;
  select * into r from online_security.turnstile_uses where reservation_id=p_reservation for update;
  now_at:=clock_timestamp();
  if r.reservation_id is null or r.game_id<>p_id or r.player_token_hash<>sha256(convert_to(p_token,'UTF8')) or r.consumed_at is not null
    or r.expires_at<=now_at or p_challenge_ts<now_at-make_interval(secs=>p.turnstile_max_age_seconds)
    or p_challenge_ts>now_at+make_interval(secs=>p.turnstile_future_skew_seconds)
    or p_challenge_ts>r.reserved_at+make_interval(secs=>p.turnstile_future_skew_seconds) then
    return jsonb_build_object('code','CAPTCHA_INVALID');
  end if;
  result:=online_security.create_game_unchecked(p_id,p_color_choice,p_token);
  if result->>'code'='OK' then
    -- Creation/trigger/unique-index waits may outlive the proof. Raising here
    -- rolls back the game, but NOT the earlier committed reservation RPC.
    now_at:=clock_timestamp();
    if r.expires_at<=now_at or p_challenge_ts<now_at-make_interval(secs=>p.turnstile_max_age_seconds) then
      raise exception 'Challenge expired during creation' using errcode='P0001';
    end if;
    update online_security.turnstile_uses set consumed_at=clock_timestamp() where reservation_id=p_reservation;
  end if;
  return result;
end;
$$;
revoke all on function public.online_api_reserve_turnstile(text,uuid,text),public.online_api_create_reserved(uuid,text,text,uuid,timestamptz),public.online_api_create(uuid,text,text) from public,anon,authenticated;
grant execute on function public.online_api_reserve_turnstile(text,uuid,text),public.online_api_create_reserved(uuid,text,text,uuid,timestamptz),public.online_api_create(uuid,text,text) to service_role;
commit;
