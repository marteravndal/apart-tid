-- Add an explicitly named, freely timed shift without changing existing shifts.
-- Access remains controlled by existing RLS and the admin-only roster function.
ALTER TABLE public.scheduled_shifts
  DROP CONSTRAINT scheduled_shifts_shift_type_check;
ALTER TABLE public.scheduled_shifts
  ADD CONSTRAINT scheduled_shifts_shift_type_check
  CHECK (shift_type IN ('day', 'evening', 'night', 'custom'));
