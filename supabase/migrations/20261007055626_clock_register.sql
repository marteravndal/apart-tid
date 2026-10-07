ALTER TABLE public.time_entries ADD COLUMN reference_no bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_reference_no_key UNIQUE(reference_no);

CREATE TABLE public.deleted_time_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  reference_no bigint NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  source public.entry_source NOT NULL,
  auto_clocked_out boolean NOT NULL DEFAULT false,
  note text,
  original_entry jsonb NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_by uuid NOT NULL REFERENCES auth.users(id),
  deletion_reason text NOT NULL CHECK(length(trim(deletion_reason)) BETWEEN 3 AND 1000)
);
CREATE INDEX deleted_time_entries_org_start_idx ON public.deleted_time_entries(organization_id,started_at DESC);
ALTER TABLE public.deleted_time_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_time_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON public.deleted_time_entries TO service_role;
CREATE POLICY "Archive uses protected service" ON public.deleted_time_entries TO authenticated USING(false);

CREATE VIEW public.clock_register WITH (security_invoker=true) AS
SELECT id,organization_id,employee_id,reference_no,started_at,ended_at,source,auto_clocked_out,note,
  NULL::timestamptz AS deleted_at,NULL::uuid AS deleted_by,NULL::text AS deletion_reason
FROM public.time_entries
UNION ALL
SELECT id,organization_id,employee_id,reference_no,started_at,ended_at,source,auto_clocked_out,note,deleted_at,deleted_by,deletion_reason
FROM public.deleted_time_entries;
REVOKE ALL ON public.clock_register FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.clock_register TO service_role;

CREATE OR REPLACE FUNCTION public.delete_clock_entry(p_organization_id uuid,p_actor_id uuid,p_entry_id uuid,p_started_at timestamptz,p_ended_at timestamptz,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE entry public.time_entries%ROWTYPE; entry_month date;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.employees WHERE auth_user_id=p_actor_id AND organization_id=p_organization_id AND role='admin' AND active) THEN
    RAISE EXCEPTION 'Kun administrator har tilgang.';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Skriv en begrunnelse på 3–1000 tegn.'; END IF;
  -- Keep deletion and its audit record atomic; serialize with month-lock insertion.
  LOCK TABLE public.month_locks IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO entry FROM public.time_entries WHERE id=p_entry_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registreringen er ikke tilgjengelig eller er allerede slettet.'; END IF;
  IF entry.ended_at IS NULL THEN RAISE EXCEPTION 'Stemple den ansatte ut før registreringen slettes.'; END IF;
  IF entry.started_at IS DISTINCT FROM p_started_at OR entry.ended_at IS DISTINCT FROM p_ended_at THEN RAISE EXCEPTION 'Registreringen er endret. Oppdater listen før du sletter.'; END IF;
  entry_month:=date_trunc('month',entry.started_at AT TIME ZONE 'Europe/Oslo')::date;
  IF EXISTS(SELECT 1 FROM public.month_locks l WHERE l.organization_id=p_organization_id AND l.month_start=entry_month AND superseded_at IS NULL)
     OR EXISTS(SELECT 1 FROM public.month_approvals a WHERE a.organization_id=p_organization_id AND a.employee_id=entry.employee_id AND a.month_start=entry_month AND status='locked')
  THEN RAISE EXCEPTION 'Måneden er låst og kan ikke endres.'; END IF;
  INSERT INTO public.deleted_time_entries(id,organization_id,employee_id,reference_no,started_at,ended_at,source,auto_clocked_out,note,original_entry,deleted_by,deletion_reason)
  VALUES(entry.id,entry.organization_id,entry.employee_id,entry.reference_no,entry.started_at,entry.ended_at,entry.source,entry.auto_clocked_out,entry.note,to_jsonb(entry),p_actor_id,trim(p_reason));
  INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
  VALUES(p_organization_id,p_actor_id,'delete_time_entry','time_entry',entry.id::text,jsonb_build_object('employee_id',entry.employee_id,'reference_no',entry.reference_no,'reason',trim(p_reason),'before',jsonb_build_object('started_at',entry.started_at,'ended_at',entry.ended_at,'source',entry.source),'after',null));
  DELETE FROM public.time_entries WHERE id=entry.id;
  UPDATE public.month_approvals SET status='open',approved_by=NULL,approved_at=NULL WHERE organization_id=p_organization_id AND employee_id=entry.employee_id AND month_approvals.month_start=entry_month;
  RETURN jsonb_build_object('ok',true,'entry_id',entry.id,'reference_no',entry.reference_no,'employee_id',entry.employee_id,'month',to_char(entry_month,'YYYY-MM'));
END;
$$;
REVOKE ALL ON FUNCTION public.delete_clock_entry(uuid,uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_clock_entry(uuid,uuid,uuid,timestamptz,timestamptz,text) TO service_role;

-- Removing a mistaken entry must not remove the recent clock-out cooldown.
-- Read-only gate used by the UI and checked again atomically on insert.
CREATE OR REPLACE FUNCTION public.clock_in_gate(p_employee_id uuid, p_organization_id uuid, p_at timestamptz DEFAULT clock_timestamp())
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE last_end timestamptz; local_day date := (p_at AT TIME ZONE 'Europe/Oslo')::date; shift_row record; next_start timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id=p_employee_id AND organization_id=p_organization_id AND active) THEN
    RETURN jsonb_build_object('allowed',false,'code','inactive','message','Brukeren er ikke aktiv. Kontakt ADMIN.');
  END IF;
  SELECT max(ended_at) INTO last_end FROM (SELECT ended_at FROM public.time_entries WHERE employee_id=p_employee_id AND organization_id=p_organization_id UNION ALL SELECT ended_at FROM public.deleted_time_entries WHERE employee_id=p_employee_id AND organization_id=p_organization_id) history;
  IF last_end IS NOT NULL AND p_at < last_end + interval '2 minutes' THEN
    RETURN jsonb_build_object('allowed',false,'code','cooldown','available_at',last_end + interval '2 minutes','message','Du har nettopp stemplet ut. Vent to minutter før du kan stemple inn igjen.');
  END IF;
  FOR shift_row IN
    SELECT ((x->>'work_date')::date + (x->>'start_time')::time) AT TIME ZONE 'Europe/Oslo' AS starts_at,
      (((x->>'work_date')::date + CASE WHEN (x->>'end_time')::time <= (x->>'start_time')::time THEN 1 ELSE 0 END) + (x->>'end_time')::time) AT TIME ZONE 'Europe/Oslo' AS ends_at
    FROM public.shift_schedules s CROSS JOIN LATERAL jsonb_array_elements(s.published_snapshot) x
    WHERE s.organization_id=p_organization_id AND s.status='published'
      AND s.week_start BETWEEN local_day-8 AND local_day+7 AND x->>'employee_id'=p_employee_id::text
    ORDER BY starts_at
  LOOP
    IF p_at >= shift_row.starts_at - interval '1 hour' AND p_at < shift_row.ends_at THEN
      RETURN jsonb_build_object('allowed',true,'shift_start',shift_row.starts_at,'shift_end',shift_row.ends_at);
    END IF;
    IF shift_row.starts_at > p_at AND next_start IS NULL THEN next_start:=shift_row.starts_at; END IF;
  END LOOP;
  RETURN jsonb_build_object('allowed',false,'code','no_shift','next_shift',next_start,'message','Du har ikke et publisert skift å stemple inn på nå. Du kan stemple inn fra én time før skiftstart. Kontakt ADMIN hvis du skal jobbe utenfor vaktlisten.');
END;
$$;
REVOKE ALL ON FUNCTION public.clock_in_gate(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clock_in_gate(uuid,uuid,timestamptz) TO service_role;

