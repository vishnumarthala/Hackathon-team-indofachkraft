-- 018: UI language and viewer time zone preferences on the user profile.
-- Additive and nullable: existing profiles keep working (null = resolve from cookie / browser).
-- time_zone is validated as an IANA zone server-side (POST /api/locale) and again when read.
-- Users cannot write user_profiles directly (only SELECT is granted to authenticated); the server
-- updates these columns with the service-role client for the signed-in user only.

alter table public.user_profiles
  add column preferred_locale text
    constraint user_profiles_preferred_locale_check check (preferred_locale in ('en', 'hi', 'te'));

alter table public.user_profiles
  add column time_zone text
    constraint user_profiles_time_zone_length_check check (char_length(time_zone) between 1 and 64);
