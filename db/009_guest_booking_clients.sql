-- A client created by a public booking has no password until they choose to
-- complete registration. The timestamp makes that state explicit without
-- weakening authentication for existing users.
ALTER TABLE public.platform_users
  ADD COLUMN IF NOT EXISTS guest_booking_at timestamptz;

CREATE INDEX IF NOT EXISTS platform_users_guest_booking_at_idx
  ON public.platform_users (guest_booking_at)
  WHERE guest_booking_at IS NOT NULL;
