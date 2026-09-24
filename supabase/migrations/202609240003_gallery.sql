-- Public read-only photo bucket. Upload and delete access is mediated by the
-- authenticated Node API using the server-only Supabase service role key.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'association-gallery',
  'association-gallery',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
