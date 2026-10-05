begin;
-- Shared workplace code, readable only through the authenticated ADMIN endpoint.
-- Existing QR tokens remain untouched. Eight digits, including leading zeroes.
alter table public.qr_codes add column reserve_code text not null
  default lpad(((('x' || substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint) % 100000000)::text,8,'0')
  check (reserve_code ~ '^[0-9]{8}$');

create table public.qr_reserve_attempts (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  attempts integer not null default 0 check (attempts between 0 and 5),
  window_started_at timestamptz not null default now()
);
alter table public.qr_reserve_attempts enable row level security;
revoke all on public.qr_reserve_attempts from public,anon,authenticated;
grant all on public.qr_reserve_attempts to service_role;
create policy "Reserve attempts use protected service" on public.qr_reserve_attempts
  for all to authenticated using (false) with check (false);

-- Called only by the Edge Function after getUser and active-employee validation.
-- A row lock serializes concurrent guesses across all Edge instances.
create function public.verify_qr_reserve(p_employee_id uuid,p_worksite_id uuid,p_code text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_attempt public.qr_reserve_attempts%rowtype;
  v_qr public.qr_codes%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if not exists (
    select 1 from public.employees e join public.worksites w on w.organization_id=e.organization_id
    where e.id=p_employee_id and e.active and w.id=p_worksite_id and w.active
  ) then return jsonb_build_object('status','invalid'); end if;
  insert into public.qr_reserve_attempts(employee_id,window_started_at)
    values(p_employee_id,v_now) on conflict(employee_id) do nothing;
  select * into v_attempt from public.qr_reserve_attempts where employee_id=p_employee_id for update;
  if v_attempt.window_started_at <= v_now - interval '15 minutes' then
    update public.qr_reserve_attempts set attempts=0,window_started_at=v_now where employee_id=p_employee_id
      returning * into v_attempt;
  end if;
  if v_attempt.attempts >= 5 then
    return jsonb_build_object('status','limited','retry_after',greatest(1,ceil(extract(epoch from v_attempt.window_started_at+interval '15 minutes'-v_now))));
  end if;
  select * into v_qr from public.qr_codes where worksite_id=p_worksite_id and reserve_code=p_code
    and revoked_at is null and valid_from<=v_now and expires_at>v_now order by created_at desc limit 1;
  if found then
    update public.qr_reserve_attempts set attempts=0,window_started_at=v_now where employee_id=p_employee_id;
    return jsonb_build_object('status','valid','id',v_qr.id,'location_check_required',v_qr.location_check_required);
  end if;
  update public.qr_reserve_attempts set attempts=attempts+1 where employee_id=p_employee_id;
  return jsonb_build_object('status','invalid');
end;
$$;
revoke execute on function public.verify_qr_reserve(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.verify_qr_reserve(uuid,uuid,text) to service_role;
commit;
