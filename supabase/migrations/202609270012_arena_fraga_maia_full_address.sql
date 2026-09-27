-- Update the shared arena address without changing scheduled game dates/times.
insert into public.settings (key, value)
values ('home_arena_address', 'Av. Francisco Fraga Maia, 6700 - Mangabeira, Feira de Santana - BA, 44056-232')
on conflict (key) do update set value = excluded.value;

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
        when lower(coalesce(arena->>'name', '')) in ('arena futmancos', 'arena fraga maia') then
          arena || jsonb_build_object(
            'name', 'Arena Fraga Maia',
            'address', 'Av. Francisco Fraga Maia, 6700 - Mangabeira, Feira de Santana - BA, 44056-232'
          )
        else arena
      end
    ), '[]'::jsonb)
    into updated_arenas
    from jsonb_array_elements(shared_state->'arenas') as item(arena);

    shared_state := jsonb_set(shared_state, '{arenas}', updated_arenas, true);
  end if;

  if jsonb_typeof(shared_state->'nextGame') = 'object'
     and lower(coalesce(shared_state #>> '{nextGame,name}', '')) in ('arena futmancos', 'arena fraga maia') then
    shared_state := jsonb_set(
      shared_state,
      '{nextGame}',
      (shared_state->'nextGame') || jsonb_build_object(
        'name', 'Arena Fraga Maia',
        'address', 'Av. Francisco Fraga Maia, 6700 - Mangabeira, Feira de Santana - BA, 44056-232'
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
