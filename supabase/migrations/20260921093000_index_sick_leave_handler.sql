create index sick_leave_requests_handled_by_idx on public.sick_leave_requests (handled_by) where handled_by is not null;
