alter table public.profiles
  add column if not exists cpf_hash text,
  add column if not exists cpf_encrypted text,
  add column if not exists cpf_last4 text,
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text;

create unique index if not exists profiles_cpf_hash_unique
  on public.profiles (cpf_hash)
  where cpf_hash is not null;

create or replace function public.create_futmancos_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_answer text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'association_answer', '')));
  signup_cpf text := regexp_replace(coalesce(new.raw_user_meta_data ->> 'cpf', ''), '[^0-9]', '', 'g');
  emergency_name text := btrim(coalesce(new.raw_user_meta_data ->> 'emergency_contact_name', ''));
  emergency_phone text := btrim(coalesce(new.raw_user_meta_data ->> 'emergency_contact_phone', ''));
begin
  if signup_answer <> 'isaac' then
    raise exception 'Resposta de validação da associação incorreta.' using errcode = '23514';
  end if;
  if length(signup_cpf) <> 11 or signup_cpf !~ '^[0-9]{11}$' then
    raise exception 'Informe um CPF válido.' using errcode = '23514';
  end if;
  if emergency_name = '' or emergency_phone = '' then
    raise exception 'Informe o nome e o telefone do contato de emergência.' using errcode = '23514';
  end if;

  insert into public.profiles (id, email, name, phone, age, position, foot, height, shirt_number, emergency_contact_name, emergency_contact_phone)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'age', '')::integer, 0),
    coalesce(nullif(new.raw_user_meta_data ->> 'position', ''), 'Meio-Campo'),
    coalesce(nullif(new.raw_user_meta_data ->> 'foot', ''), 'Direita'),
    coalesce(nullif(new.raw_user_meta_data ->> 'height', '')::numeric, 1.70),
    coalesce(nullif(new.raw_user_meta_data ->> 'shirt_number', '')::smallint, 0),
    emergency_name,
    emergency_phone
  );
  return new;
end;
$$;
