-- Shared venue and regular playing hours shown in the public home and Resenha.
insert into public.settings (key, value) values
  ('home_arena_name', 'Arena Fraga Maia'),
  ('home_arena_address', 'Fraga Maia - Feira de Santana/BA'),
  ('home_game_schedule', 'Sábados, das 6h30 às 8h30')
on conflict (key) do update set value = excluded.value;

-- Replace the previous default venue in already-saved association data.
do $$
declare
  shared_state jsonb;
  updated_arenas jsonb;
begin
  select state_json into shared_state
  from public.app_state
  where id = 1;

  if shared_state is null then
    return;
  end if;

  if jsonb_typeof(shared_state->'arenas') = 'array' then
    select coalesce(jsonb_agg(
      case
        when lower(coalesce(arena->>'name', '')) = 'arena futmancos' then
          arena || jsonb_build_object(
            'name', 'Arena Fraga Maia',
            'address', 'Fraga Maia - Feira de Santana/BA'
          )
        else arena
      end
    ), '[]'::jsonb)
    into updated_arenas
    from jsonb_array_elements(shared_state->'arenas') as item(arena);

    shared_state := jsonb_set(shared_state, '{arenas}', updated_arenas, true);
  end if;

  if jsonb_typeof(shared_state->'nextGame') = 'object'
     and lower(coalesce(shared_state #>> '{nextGame,name}', '')) = 'arena futmancos' then
    shared_state := jsonb_set(
      shared_state,
      '{nextGame}',
      (shared_state->'nextGame') || jsonb_build_object(
        'name', 'Arena Fraga Maia',
        'address', 'Fraga Maia - Feira de Santana/BA'
      ),
      true
    );
  end if;

  update public.app_state
  set state_json = shared_state,
      updated_at = now()
  where id = 1;
end;
$$;
