-- Link attendance to a roster slot without deleting history when a slot is removed.
ALTER TABLE public.time_entries ADD COLUMN scheduled_shift_id uuid;
CREATE UNIQUE INDEX time_entries_scheduled_shift_unique ON public.time_entries(scheduled_shift_id) WHERE scheduled_shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_roster_attendance()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.employee_id::text,73421));
  IF EXISTS(SELECT 1 FROM public.time_entries t WHERE t.employee_id=NEW.employee_id AND t.organization_id=NEW.organization_id AND t.id<>NEW.id
    AND (NEW.scheduled_shift_id IS NOT NULL OR t.scheduled_shift_id IS NOT NULL)
    AND tstzrange(t.started_at,t.ended_at,'[)') && tstzrange(NEW.started_at,NEW.ended_at,'[)'))
  THEN RAISE EXCEPTION 'Tidene overlapper en registrering. Kontroller timelisten under Godkjenning før du etterregistrerer.'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_roster_attendance() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_roster_attendance() TO service_role;
CREATE TRIGGER guard_roster_attendance BEFORE INSERT OR UPDATE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.guard_roster_attendance();

CREATE OR REPLACE FUNCTION public.stamp_roster_shift(p_organization_id uuid,p_actor_id uuid,p_shift_id uuid,p_expected jsonb,p_started_at timestamptz,p_ended_at timestamptz,p_kind text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE shift public.scheduled_shifts%ROWTYPE; entry public.time_entries%ROWTYPE; worksite uuid; first_month date; last_month date;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.employees WHERE organization_id=p_organization_id AND auth_user_id=p_actor_id AND active AND role='admin') THEN RAISE EXCEPTION 'Kun administrator har tilgang.'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('work','sick_pay') OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Velg arbeid eller sykepenger og skriv en begrunnelse på 3–1000 tegn.'; END IF;
  IF p_started_at IS NULL OR p_ended_at IS NULL OR NOT isfinite(p_started_at) OR NOT isfinite(p_ended_at) OR p_ended_at<=p_started_at OR p_ended_at>clock_timestamp() OR p_ended_at-p_started_at>interval '24 hours' THEN RAISE EXCEPTION 'Kontroller tidene. Etterregistrering gjelder avsluttede vakter på høyst 24 timer.'; END IF;
  LOCK TABLE public.month_locks IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO shift FROM public.scheduled_shifts WHERE id=p_shift_id AND organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vakten finnes ikke. Oppdater vaktlisten.'; END IF;
  IF p_expected IS NULL OR p_expected->>'employee_id' IS DISTINCT FROM shift.employee_id::text OR p_expected->>'work_date' IS DISTINCT FROM shift.work_date::text OR p_expected->>'start_time' IS DISTINCT FROM left(shift.start_time::text,5) OR p_expected->>'end_time' IS DISTINCT FROM left(shift.end_time::text,5) THEN RAISE EXCEPTION 'Vakten er endret. Oppdater vaktlisten før du etterregistrerer.'; END IF;
  IF (p_started_at AT TIME ZONE 'Europe/Oslo')::date<>shift.work_date THEN RAISE EXCEPTION 'Startdatoen må være datoen for vakten.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.employees WHERE id=shift.employee_id AND organization_id=p_organization_id) THEN RAISE EXCEPTION 'Ansatt finnes ikke.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(shift.employee_id::text,73421));
  IF EXISTS(SELECT 1 FROM public.time_entries WHERE scheduled_shift_id=p_shift_id) THEN RAISE EXCEPTION 'Vakten er allerede etterregistrert. Bruk Godkjenning for å endre den.'; END IF;
  first_month:=date_trunc('month',p_started_at AT TIME ZONE 'Europe/Oslo')::date;
  last_month:=date_trunc('month',(p_ended_at-interval '1 microsecond') AT TIME ZONE 'Europe/Oslo')::date;
  IF EXISTS(SELECT 1 FROM public.month_locks WHERE organization_id=p_organization_id AND month_start BETWEEN first_month AND last_month AND superseded_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.month_approvals WHERE organization_id=p_organization_id AND employee_id=shift.employee_id AND month_start BETWEEN first_month AND last_month AND status='locked') THEN RAISE EXCEPTION 'Perioden er låst og kan ikke endres.'; END IF;
  IF EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE organization_id=p_organization_id AND employee_id=shift.employee_id AND category='sick_pay' AND work_date BETWEEN (p_started_at AT TIME ZONE 'Europe/Oslo')::date AND ((p_ended_at-interval '1 microsecond') AT TIME ZONE 'Europe/Oslo')::date) THEN RAISE EXCEPTION 'Det er allerede ført sykepenger på denne datoen. Kontroller fraværsføringen før du etterregistrerer.'; END IF;
  SELECT id INTO worksite FROM public.worksites WHERE organization_id=p_organization_id AND active ORDER BY id LIMIT 1;
  IF worksite IS NULL THEN RAISE EXCEPTION 'Aktivt arbeidssted mangler.'; END IF;
  INSERT INTO public.time_entries(organization_id,employee_id,worksite_id,kind,started_at,ended_at,source,note,created_by,scheduled_shift_id)
  VALUES(p_organization_id,shift.employee_id,worksite,p_kind::public.entry_kind,p_started_at,p_ended_at,'manual','Etterregistrert fra vaktlisten: '||trim(p_reason),p_actor_id,p_shift_id) RETURNING * INTO entry;
  UPDATE public.month_approvals SET status='open',approved_at=NULL,approved_by=NULL WHERE organization_id=p_organization_id AND employee_id=shift.employee_id AND month_start BETWEEN first_month AND last_month;
  INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
  VALUES(p_organization_id,p_actor_id,'stamp_roster_shift','time_entry',entry.id::text,jsonb_build_object('employee_id',shift.employee_id,'shift_id',shift.id,'reference_no',entry.reference_no,'kind',p_kind,'reason',trim(p_reason),'planned',jsonb_build_object('work_date',shift.work_date,'start_time',shift.start_time,'end_time',shift.end_time),'after',jsonb_build_object('started_at',p_started_at,'ended_at',p_ended_at,'kind',p_kind)));
  RETURN jsonb_build_object('entry',jsonb_build_object('id',entry.id,'reference_no',entry.reference_no,'employee_id',entry.employee_id,'started_at',entry.started_at,'ended_at',entry.ended_at,'kind',entry.kind,'scheduled_shift_id',entry.scheduled_shift_id));
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_roster_shift(uuid,uuid,uuid,jsonb,timestamptz,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_roster_shift(uuid,uuid,uuid,jsonb,timestamptz,timestamptz,text,text) TO service_role;

CREATE OR REPLACE VIEW public.clock_register WITH (security_invoker=true) AS
SELECT id,organization_id,employee_id,reference_no,started_at,ended_at,source,auto_clocked_out,note,
  NULL::timestamptz AS deleted_at,NULL::uuid AS deleted_by,NULL::text AS deletion_reason,kind::text AS kind
FROM public.time_entries
UNION ALL
SELECT id,organization_id,employee_id,reference_no,started_at,ended_at,source,auto_clocked_out,note,deleted_at,deleted_by,deletion_reason,original_entry->>'kind'
FROM public.deleted_time_entries;
REVOKE ALL ON public.clock_register FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.clock_register TO service_role;
