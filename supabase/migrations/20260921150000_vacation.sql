create table public.vacation_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  request_type text not null check (request_type in ('vacation','leave')),
  start_date date not null,
  end_date date not null,
  vacation_year integer not null check (vacation_year between 2020 and 2200),
  requested_days integer not null check (requested_days > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  employee_note text,
  admin_comment text,
  handled_by uuid references auth.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (extract(year from start_date)::integer = vacation_year),
  check (extract(year from end_date)::integer = vacation_year)
);

create table public.vacation_carryover_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  from_year integer not null check (from_year between 2020 and 2200),
  to_year integer generated always as (from_year + 1) stored,
  days integer not null check (days between 1 and 12),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  employee_note text,
  admin_comment text,
  handled_by uuid references auth.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vacation_requests_org_status_idx on public.vacation_requests (organization_id,status,created_at desc);
create index vacation_requests_employee_year_idx on public.vacation_requests (employee_id,vacation_year,status);
create index vacation_carryover_org_status_idx on public.vacation_carryover_requests (organization_id,status,created_at desc);
create index vacation_carryover_employee_year_idx on public.vacation_carryover_requests (employee_id,from_year,status);
create unique index vacation_carryover_one_active_idx on public.vacation_carryover_requests (employee_id,from_year) where status in ('pending','approved');

alter table public.vacation_requests enable row level security;
alter table public.vacation_carryover_requests enable row level security;
revoke all on table public.vacation_requests from anon,authenticated;
revoke all on table public.vacation_carryover_requests from anon,authenticated;
grant all on table public.vacation_requests to service_role;
grant all on table public.vacation_carryover_requests to service_role;

create or replace function public.process_vacation_request(p_request_id uuid,p_status text,p_admin_comment text,p_handled_by uuid)
returns jsonb language plpgsql set search_path=''
as $$
declare v_request public.vacation_requests%rowtype; v_allowance integer; v_reserved integer;
begin
  if p_status not in ('approved','rejected') then raise exception 'Ugyldig status.'; end if;
  select * into v_request from public.vacation_requests where id=p_request_id for update;
  if not found then raise exception 'Ferieønsket finnes ikke.'; end if;
  if v_request.status <> 'pending' then raise exception 'Ferieønsket er allerede behandlet.'; end if;
  if p_status='approved' and v_request.request_type='vacation' then
    select 25 + coalesce(sum(days),0) into v_allowance from public.vacation_carryover_requests
      where employee_id=v_request.employee_id and to_year=v_request.vacation_year and status='approved';
    select coalesce(sum(requested_days),0) into v_reserved from public.vacation_requests
      where employee_id=v_request.employee_id and vacation_year=v_request.vacation_year and request_type='vacation'
        and status='approved' and id<>v_request.id;
    if v_reserved + v_request.requested_days > v_allowance then raise exception 'Den ansatte har ikke nok feriedager tilgjengelig.'; end if;
  end if;
  update public.vacation_requests set status=p_status,admin_comment=nullif(trim(p_admin_comment),''),handled_by=p_handled_by,handled_at=now(),updated_at=now() where id=p_request_id;
  insert into public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
  values(v_request.organization_id,p_handled_by,'handle_vacation_request','vacation_request',v_request.id::text,jsonb_build_object('status',p_status,'comment',nullif(trim(p_admin_comment),'')));
  return jsonb_build_object('id',v_request.id,'status',p_status);
end; $$;

create or replace function public.process_vacation_carryover(p_request_id uuid,p_status text,p_admin_comment text,p_handled_by uuid)
returns jsonb language plpgsql set search_path=''
as $$
declare v_request public.vacation_carryover_requests%rowtype; v_allowance integer; v_used integer; v_already integer;
begin
  if p_status not in ('approved','rejected') then raise exception 'Ugyldig status.'; end if;
  select * into v_request from public.vacation_carryover_requests where id=p_request_id for update;
  if not found then raise exception 'Overføringssøknaden finnes ikke.'; end if;
  if v_request.status <> 'pending' then raise exception 'Overføringssøknaden er allerede behandlet.'; end if;
  if p_status='approved' then
    select 25 + coalesce(sum(days),0) into v_allowance from public.vacation_carryover_requests where employee_id=v_request.employee_id and to_year=v_request.from_year and status='approved';
    select coalesce(sum(requested_days),0) into v_used from public.vacation_requests where employee_id=v_request.employee_id and vacation_year=v_request.from_year and request_type='vacation' and status='approved';
    select coalesce(sum(days),0) into v_already from public.vacation_carryover_requests where employee_id=v_request.employee_id and from_year=v_request.from_year and status='approved' and id<>v_request.id;
    if v_already + v_request.days > 12 then raise exception 'Maksimalt 12 dager kan overføres.'; end if;
    if v_used + v_already + v_request.days > v_allowance then raise exception 'Den ansatte har ikke nok ubrukte feriedager.'; end if;
  end if;
  update public.vacation_carryover_requests set status=p_status,admin_comment=nullif(trim(p_admin_comment),''),handled_by=p_handled_by,handled_at=now(),updated_at=now() where id=p_request_id;
  insert into public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
  values(v_request.organization_id,p_handled_by,'handle_vacation_carryover','vacation_carryover_request',v_request.id::text,jsonb_build_object('status',p_status,'days',v_request.days,'from_year',v_request.from_year,'to_year',v_request.to_year,'comment',nullif(trim(p_admin_comment),'')));
  return jsonb_build_object('id',v_request.id,'status',p_status,'days',v_request.days,'to_year',v_request.to_year);
end; $$;

revoke execute on function public.process_vacation_request(uuid,text,text,uuid) from public,anon,authenticated;
revoke execute on function public.process_vacation_carryover(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.process_vacation_request(uuid,text,text,uuid) to service_role;
grant execute on function public.process_vacation_carryover(uuid,text,text,uuid) to service_role;
