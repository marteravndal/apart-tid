create table public.sick_leave_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  absence_type text not null check (absence_type in ('self_certification','medical_certificate','sick_child')),
  start_date date not null,
  end_date date not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  routine_version text not null,
  routine_acknowledged_at timestamptz not null,
  employee_note text,
  admin_comment text,
  handled_by uuid references auth.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (absence_type = 'medical_certificate' or start_date = end_date)
);

create index sick_leave_requests_org_status_idx on public.sick_leave_requests (organization_id, status, created_at desc);
create index sick_leave_requests_employee_idx on public.sick_leave_requests (employee_id, created_at desc);
create unique index sick_leave_requests_no_duplicate_idx on public.sick_leave_requests (employee_id, absence_type, start_date, end_date) where status in ('pending','approved');

alter table public.payroll_adjustments drop constraint payroll_adjustments_category_check;
alter table public.payroll_adjustments add constraint payroll_adjustments_category_check check (category in ('overtime_100'::public.payroll_category, 'sick_pay'::public.payroll_category));
alter table public.payroll_adjustments add column sick_leave_request_id uuid references public.sick_leave_requests(id);
create unique index payroll_adjustments_sick_leave_day_idx on public.payroll_adjustments (sick_leave_request_id, work_date) where sick_leave_request_id is not null;

alter table public.sick_leave_requests enable row level security;
revoke all on table public.sick_leave_requests from anon, authenticated;
grant all on table public.sick_leave_requests to service_role;

create or replace function public.process_sick_leave_request(
  p_request_id uuid,
  p_status text,
  p_admin_comment text,
  p_handled_by uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_request public.sick_leave_requests%rowtype;
  v_day date;
  v_days integer := 0;
begin
  if p_status not in ('approved','rejected') then raise exception 'Ugyldig status.'; end if;
  select * into v_request from public.sick_leave_requests where id=p_request_id for update;
  if not found then raise exception 'Fraværsmeldingen finnes ikke.'; end if;
  if v_request.status <> 'pending' then raise exception 'Fraværsmeldingen er allerede behandlet.'; end if;

  if p_status='approved' then
    for v_day in select d::date from generate_series(v_request.start_date::timestamp, v_request.end_date::timestamp, interval '1 day') d loop
      if v_request.absence_type <> 'medical_certificate' or extract(isodow from v_day) between 1 and 5 then
        insert into public.payroll_adjustments (organization_id,employee_id,work_date,category,hours,note,created_by,sick_leave_request_id)
        values (v_request.organization_id,v_request.employee_id,v_day,'sick_pay',8,
          case v_request.absence_type when 'self_certification' then 'Godkjent egenmelding' when 'medical_certificate' then 'Godkjent sykmelding fra lege' else 'Godkjent sykt barn' end,
          p_handled_by,v_request.id);
        v_days := v_days + 1;
      end if;
    end loop;
    if v_days=0 then raise exception 'Perioden inneholder ingen hverdager.'; end if;
  end if;

  update public.sick_leave_requests set status=p_status,admin_comment=nullif(trim(p_admin_comment),''),handled_by=p_handled_by,handled_at=now(),updated_at=now() where id=p_request_id;
  insert into public.audit_logs (organization_id,actor_id,action,entity_type,entity_id,details)
  values (v_request.organization_id,p_handled_by,'handle_sick_leave','sick_leave_request',v_request.id::text,jsonb_build_object('status',p_status,'days',v_days,'comment',nullif(trim(p_admin_comment),'')));
  return jsonb_build_object('id',v_request.id,'status',p_status,'days',v_days,'hours',v_days*8);
end;
$$;

revoke execute on function public.process_sick_leave_request(uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.process_sick_leave_request(uuid,text,text,uuid) to service_role;
