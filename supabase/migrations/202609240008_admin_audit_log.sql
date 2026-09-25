create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null default '',
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon, authenticated;
grant all on public.admin_audit_logs to service_role;
create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs (created_at desc);
