-- Preserve historical QR/manual entries while identifying the new button flow.
ALTER TYPE public.entry_source ADD VALUE IF NOT EXISTS 'location';
