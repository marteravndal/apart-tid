create index scheduled_shifts_organization_idx on public.scheduled_shifts(organization_id);
create index scheduled_shifts_created_by_idx on public.scheduled_shifts(created_by);
create index shift_schedules_published_by_idx on public.shift_schedules(published_by);
create index shift_schedules_created_by_idx on public.shift_schedules(created_by);
create index shift_settings_updated_by_idx on public.shift_settings(updated_by);
