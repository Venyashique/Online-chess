begin;

-- JSON structure validation only; chess legality is verified on replay by ChessGame.
create function public.online_game_moves_valid(p_moves jsonb)
returns boolean language plpgsql immutable
set search_path = ''
as $$
declare m jsonb;
begin
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then return false; end if;
  if jsonb_array_length(p_moves) > 4096 then return false; end if;
  for m in select value from jsonb_array_elements(p_moves) loop
    if jsonb_typeof(m) <> 'object'
      or not (m ? 'from' and m ? 'to')
      or jsonb_typeof(m->'from') <> 'string'
      or jsonb_typeof(m->'to') <> 'string'
      or m->>'from' !~ '^[a-h][1-8]$'
      or m->>'to' !~ '^[a-h][1-8]$'
      or m->>'from' = m->>'to'
      or (m - 'from' - 'to' - 'promotion') <> '{}'::jsonb
      or (m ? 'promotion' and (jsonb_typeof(m->'promotion') <> 'string' or m->>'promotion' !~ '^[qrbn]$'))
    then return false; end if;
  end loop;
  return true;
end;
$$;

create table public.online_games (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  initial_fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves jsonb not null default '[]'::jsonb,
  creator_color_choice text not null default 'white',
  creator_color text not null default 'w',
  version integer not null default 1,
  constraint online_games_fen_length check (length(btrim(initial_fen)) between 15 and 128),
  constraint online_games_moves_valid check (public.online_game_moves_valid(moves)),
  constraint online_games_color_choice check (creator_color_choice in ('white', 'black', 'random')),
  constraint online_games_color check (creator_color in ('w', 'b')),
  constraint online_games_choice_matches check (
    creator_color_choice = 'random'
    or (creator_color_choice = 'white' and creator_color = 'w')
    or (creator_color_choice = 'black' and creator_color = 'b')
  ),
  constraint online_games_version_positive check (version > 0)
);

-- No row-level policies grant direct access. Table is private to its owner.
alter table public.online_games enable row level security;
revoke all on table public.online_games from public, anon, authenticated;
revoke all on function public.online_game_moves_valid(jsonb) from public, anon, authenticated;

-- The UUID is a read capability. The API cannot list parties or accept arbitrary
-- FEN/history on creation, and exposes no update/delete/player-join operation.
create function public.create_online_game(p_color_choice text default 'white')
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  g public.online_games;
  resolved_color text;
begin
  if p_color_choice is null or p_color_choice not in ('white', 'black', 'random') then
    raise exception 'Invalid creator color choice' using errcode = '22023';
  end if;
  resolved_color := case
    when p_color_choice = 'white' then 'w'
    when p_color_choice = 'black' then 'b'
    when random() < 0.5 then 'w'
    else 'b'
  end;
  insert into public.online_games (creator_color_choice, creator_color)
    values (p_color_choice, resolved_color) returning * into g;
  return to_jsonb(g);
end;
$$;

create function public.get_online_game(p_id uuid)
returns jsonb language sql stable security definer
set search_path = ''
as $$
  select to_jsonb(g) from public.online_games as g where g.id = p_id;
$$;

revoke all on function public.create_online_game(text) from public;
revoke all on function public.get_online_game(uuid) from public;
grant execute on function public.create_online_game(text) to anon, authenticated;
grant execute on function public.get_online_game(uuid) to anon, authenticated;

comment on table public.online_games is '4A: create and read by UUID capability; no public table access, updates, or Realtime.';
comment on column public.online_games.moves is 'Ordered coordinate actions: [{"from":"e2","to":"e4"},{"from":"a7","to":"a8","promotion":"q"}].';
comment on column public.online_games.version is 'Reserved for optimistic concurrency in a future write API. Version 1 is immutable in 4A.';

commit;
