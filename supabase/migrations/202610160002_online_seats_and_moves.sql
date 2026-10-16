begin;

-- Existing 4A rows remain readable, but unowned: no caller may claim their
-- creator seat. New playable games use create_online_game_with_seat.
alter table public.online_games
  add column creator_token_hash bytea,
  add column opponent_token_hash bytea,
  add column creator_joined_at timestamptz,
  add column opponent_joined_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint online_games_creator_identity check (
    (creator_token_hash is null and creator_joined_at is null)
    or (octet_length(creator_token_hash) = 32 and creator_joined_at is not null and creator_token_hash is not null)
  ),
  add constraint online_games_opponent_identity check (
    (opponent_token_hash is null and opponent_joined_at is null)
    or (octet_length(opponent_token_hash) = 32 and opponent_joined_at is not null and opponent_token_hash is not null and creator_token_hash is not null)
  ),
  add constraint online_games_distinct_tokens check (
    opponent_token_hash is null or opponent_token_hash <> creator_token_hash
  );

create function public.online_game_public(g public.online_games)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id, 'created_at', g.created_at, 'initial_fen', g.initial_fen,
    'moves', g.moves, 'creator_color_choice', g.creator_color_choice,
    'creator_color', g.creator_color, 'version', g.version,
    'updated_at', g.updated_at, 'creator_joined_at', g.creator_joined_at,
    'opponent_joined_at', g.opponent_joined_at, 'legacy', g.creator_token_hash is null
  );
$$;

create function public.online_seat_color(g public.online_games, p_token text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_token is null or p_token !~ '^[0-9a-f]{64}$' then null
    when g.creator_token_hash = sha256(convert_to(p_token, 'UTF8')) then g.creator_color
    when g.opponent_token_hash = sha256(convert_to(p_token, 'UTF8')) then
      case when g.creator_color = 'w' then 'b' else 'w' end
    else null
  end;
$$;

create function public.online_game_session(g public.online_games, p_token text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'game', public.online_game_public(g),
    'player_color', public.online_seat_color(g, p_token),
    'identity', case when g.creator_token_hash is null then 'legacy'
      when public.online_seat_color(g, p_token) is not null then 'recognized'
      when p_token is null then 'none' else 'invalid' end
  );
$$;

-- All public responses are explicit projections. Never return to_jsonb(g)
-- after adding credential hashes to the row type.
create or replace function public.get_online_game(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.online_game_public(g) from public.online_games g where g.id = p_id;
$$;

-- Compatibility with the 4A client: creates a read-only legacy row.
create or replace function public.create_online_game(p_color_choice text default 'white')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.online_games;
begin
  if p_color_choice is null or p_color_choice not in ('white', 'black', 'random') then
    raise exception 'Invalid creator color choice' using errcode = '22023';
  end if;
  insert into public.online_games(creator_color_choice, creator_color)
    values(p_color_choice, case when p_color_choice = 'white' then 'w'
      when p_color_choice = 'black' then 'b' when random() < 0.5 then 'w' else 'b' end)
    returning * into g;
  return public.online_game_public(g);
end;
$$;

create function public.create_online_game_with_seat(p_id uuid, p_color_choice text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.online_games;
begin
  if p_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$'
    or p_color_choice is null or p_color_choice not in ('white','black','random') then
    raise exception 'Invalid game creation parameters' using errcode = '22023';
  end if;
  insert into public.online_games(id, creator_color_choice, creator_color, creator_token_hash, creator_joined_at)
    values(p_id, p_color_choice,
      case when p_color_choice = 'white' then 'w' when p_color_choice = 'black' then 'b'
        when random() < 0.5 then 'w' else 'b' end,
      sha256(convert_to(p_token, 'UTF8')), now())
    on conflict(id) do nothing;
  select * into g from public.online_games where id = p_id for update;
  if public.online_seat_color(g, p_token) is distinct from g.creator_color then
    return jsonb_build_object('code', 'GAME_EXISTS');
  end if;
  return jsonb_build_object('code', 'OK', 'session', public.online_game_session(g, p_token));
end;
$$;

create function public.get_online_game_session(p_id uuid, p_token text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.online_game_session(g, p_token) from public.online_games g where g.id = p_id;
$$;

create function public.join_online_game(p_id uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.online_games;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid player token' using errcode = '22023';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND'); end if;
  if g.creator_token_hash is null then return jsonb_build_object('code', 'LEGACY_READ_ONLY'); end if;
  if public.online_seat_color(g, p_token) is not null then
    return jsonb_build_object('code', 'OK', 'session', public.online_game_session(g, p_token));
  end if;
  if g.opponent_token_hash is not null then return jsonb_build_object('code', 'GAME_FULL'); end if;
  update public.online_games set opponent_token_hash = sha256(convert_to(p_token, 'UTF8')),
    opponent_joined_at = now(), updated_at = now(), version = version + 1
    where id = p_id returning * into g;
  return jsonb_build_object('code', 'OK', 'session', public.online_game_session(g, p_token));
end;
$$;

-- Trusted commit boundary. Only the Edge Function's service role may execute.
-- Authoritative chess legality is checked by chess.js in that function before
-- this RPC; PostgreSQL rechecks identity/turn/version under the row lock.
create function public.commit_online_move(
  p_id uuid, p_token text, p_expected_version integer,
  p_from text, p_to text, p_promotion text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.online_games; seat text; turn_color text; action jsonb;
begin
  select * into g from public.online_games where id = p_id for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND'); end if;
  seat := public.online_seat_color(g, p_token);
  if seat is null then return jsonb_build_object('code', 'INVALID_TOKEN'); end if;
  if g.opponent_token_hash is null then return jsonb_build_object('code', 'NOT_READY'); end if;
  if p_expected_version is null or g.version <> p_expected_version then
    return jsonb_build_object('code', 'VERSION_CONFLICT');
  end if;
  turn_color := split_part(g.initial_fen, ' ', 2);
  if jsonb_array_length(g.moves) % 2 = 1 then
    turn_color := case when turn_color = 'w' then 'b' else 'w' end;
  end if;
  if seat is distinct from turn_color then return jsonb_build_object('code', 'NOT_YOUR_TURN'); end if;
  action := jsonb_strip_nulls(jsonb_build_object('from', p_from, 'to', p_to, 'promotion', p_promotion));
  if not public.online_game_moves_valid(jsonb_build_array(action)) then
    return jsonb_build_object('code', 'INVALID_MOVE');
  end if;
  update public.online_games set moves = moves || jsonb_build_array(action),
    version = version + 1, updated_at = now() where id = p_id returning * into g;
  return jsonb_build_object('code', 'OK', 'session', public.online_game_session(g, p_token));
end;
$$;

revoke all on function public.online_game_public(public.online_games) from public, anon, authenticated;
revoke all on function public.online_seat_color(public.online_games, text) from public, anon, authenticated;
revoke all on function public.online_game_session(public.online_games, text) from public, anon, authenticated;
revoke all on function public.create_online_game_with_seat(uuid, text, text) from public;
revoke all on function public.get_online_game_session(uuid, text) from public;
revoke all on function public.join_online_game(uuid, text) from public;
revoke all on function public.commit_online_move(uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.create_online_game_with_seat(uuid, text, text) to anon, authenticated;
grant execute on function public.get_online_game_session(uuid, text) to anon, authenticated, service_role;
grant execute on function public.join_online_game(uuid, text) to anon, authenticated;
grant execute on function public.commit_online_move(uuid, text, integer, text, text, text) to service_role;

-- Explicitly retain 4A's direct-table denial and RLS. No broad write policy.
alter table public.online_games enable row level security;
revoke all on table public.online_games from public, anon, authenticated;
comment on column public.online_games.version is 'Incremented by first join and each successful move. Used for atomic compare-and-swap.';
comment on function public.commit_online_move(uuid, text, integer, text, text, text) is 'Service-role-only commit; callers MUST validate chess legality in the trusted Edge Function first.';
commit;
