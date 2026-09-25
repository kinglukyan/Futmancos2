-- Query performance and foreign-key maintenance indexes for Futmancos.
-- This migration does not change or delete application data.

-- The profiles list is sorted by name in the admin and shared-state endpoints.
create index if not exists profiles_name_idx
  on public.profiles (name);

-- The admin checks whether a shirt number is already used.
create index if not exists profiles_shirt_number_idx
  on public.profiles (shirt_number)
  where shirt_number > 0;

-- These indexes support profile deletion cascades and direct lookups by member.
create index if not exists baba_attendance_user_id_idx
  on public.baba_attendance (user_id);

create index if not exists baba_votes_voter_id_idx
  on public.baba_votes (voter_id);

create index if not exists baba_guest_attendance_guest_id_idx
  on public.baba_guest_attendance (guest_id);

create index if not exists baba_guest_attendance_marked_by_idx
  on public.baba_guest_attendance (marked_by)
  where marked_by is not null;

create index if not exists admin_audit_logs_actor_id_idx
  on public.admin_audit_logs (actor_id)
  where actor_id is not null;

create index if not exists notification_deliveries_user_id_idx
  on public.notification_deliveries (user_id);

-- Admin guest listing is ordered newest first.
create index if not exists baba_guests_created_at_idx
  on public.baba_guests (created_at desc);

-- Remove standalone indexes whose leading columns are already covered by
-- unique constraints. Keeping both duplicates slows inserts/updates and uses
-- extra disk; the unique constraint indexes remain in place.
drop index if exists public.baba_attendance_game_day_idx;
drop index if exists public.baba_votes_game_day_idx;
drop index if exists public.baba_guest_attendance_game_day_idx;
drop index if exists public.baba_draws_game_day_idx;

-- Refresh planner statistics after the index changes.
analyze public.profiles;
analyze public.baba_attendance;
analyze public.baba_votes;
analyze public.baba_guest_attendance;
analyze public.admin_audit_logs;
analyze public.notification_deliveries;
analyze public.baba_guests;
