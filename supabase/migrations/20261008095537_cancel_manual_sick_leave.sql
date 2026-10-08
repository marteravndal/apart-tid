ALTER TABLE public.sick_leave_requests ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancelled_by uuid REFERENCES auth.users(id), ADD COLUMN cancellation_reason text;
ALTER TABLE public.sick_leave_requests ADD CONSTRAINT cancelled_sick_leave_is_rejected CHECK(cancelled_at IS NULL OR (status='rejected' AND cancelled_by IS NOT NULL AND length(trim(cancellation_reason)) BETWEEN 3 AND 1000));
CREATE FUNCTION public.cancel_manual_sick_leave(p_org uuid,p_actor uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sick_leave_requests%ROWTYPE; c record; first_date date; last_date date; first_id uuid; removed jsonb; n integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE organization_id=p_org AND auth_user_id=p_actor AND role='admin' AND active) THEN RAISE EXCEPTION 'Kun administrator har tilgang.'; END IF;
 IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Skriv en kort begrunnelse (3–1000 tegn).'; END IF;
 -- Same ordering as weekly closing; payroll removal and absence cancellation are one transaction.
 LOCK TABLE public.time_entries,public.payroll_adjustments,public.shift_schedules,public.weekly_item_approvals,public.weekly_shift_resolutions,public.weekly_employee_locks,public.weekly_period_locks IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM public.sick_leave_requests WHERE id=p_request AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Fraværet finnes ikke.'; END IF;
 IF coalesce(r.routine_version,'') NOT LIKE 'admin-manual-%' THEN RAISE EXCEPTION 'Bare manuelt registrert sykefravær kan slettes her.'; END IF;
 IF r.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'already_cancelled',true,'notification_sent',false); END IF;
 IF EXISTS(SELECT 1 FROM public.weekly_period_locks WHERE organization_id=p_org AND superseded_at IS NULL AND week_start<=r.end_date AND week_start+6>=r.start_date)
 OR EXISTS(SELECT 1 FROM public.weekly_employee_locks WHERE organization_id=p_org AND employee_id=r.employee_id AND superseded_at IS NULL AND week_start<=r.end_date AND week_start+6>=r.start_date)
 THEN RAISE EXCEPTION 'Fraværet berører en låst uke. Gjenåpne uken i Ukesluttkontroll før du sletter.'; END IF;
 IF EXISTS(SELECT 1 FROM public.month_locks WHERE organization_id=p_org AND superseded_at IS NULL AND month_start<=r.end_date AND (month_start+interval '1 month')::date>r.start_date)
 OR EXISTS(SELECT 1 FROM public.month_approvals WHERE organization_id=p_org AND employee_id=r.employee_id AND status='locked' AND month_start<=r.end_date AND (month_start+interval '1 month')::date>r.start_date)
 THEN RAISE EXCEPTION 'Fraværet berører en låst lønnsmåned og kan ikke slettes.'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') INTO removed FROM public.payroll_adjustments a WHERE organization_id=p_org AND employee_id=r.employee_id AND sick_leave_request_id=r.id;
 -- Existing payroll triggers also protect the actual adjustment dates if they differ from the request.
 DELETE FROM public.payroll_adjustments WHERE organization_id=p_org AND employee_id=r.employee_id AND sick_leave_request_id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public.sick_leave_requests SET status='rejected',cancelled_at=now(),cancelled_by=p_actor,cancellation_reason=trim(p_reason),updated_at=now() WHERE id=r.id;
 FOR c IN SELECT sc.* FROM public.sick_followup_cases sc JOIN public.sick_followup_case_requests cr ON cr.case_id=sc.id WHERE cr.request_id=r.id AND sc.organization_id=p_org FOR UPDATE OF sc LOOP
  SELECT min(sr.start_date),max(sr.end_date),(array_agg(sr.id ORDER BY sr.start_date,sr.id))[1] INTO first_date,last_date,first_id
  FROM public.sick_followup_case_requests cr JOIN public.sick_leave_requests sr ON sr.id=cr.request_id WHERE cr.case_id=c.id AND sr.organization_id=p_org AND sr.status='approved' AND sr.cancelled_at IS NULL;
  IF first_date IS NULL THEN
   UPDATE public.sick_followup_cases SET status='closed',closed_at=coalesce(closed_at,now()),next_followup_date=NULL,updated_at=now() WHERE id=c.id;
  ELSE
   UPDATE public.sick_followup_cases SET start_date=first_date,current_end_date=last_date,initial_request_id=first_id,updated_at=now() WHERE id=c.id;
  END IF;
  INSERT INTO public.sick_followup_activities(organization_id,case_id,activity_type,occurred_on,title,summary,created_by)
  VALUES(p_org,c.id,'other',(now() AT TIME ZONE 'Europe/Oslo')::date,'Manuelt sykefravær slettet',format('Perioden %s–%s ble slettet av ADMIN. Begrunnelse: %s. %s',r.start_date,r.end_date,trim(p_reason),CASE WHEN first_date IS NULL THEN 'Oppfølgingssaken er avsluttet; historikken beholdes.' ELSE 'Perioden er beregnet på nytt fra gjenværende sykmeldinger.' END),p_actor);
 END LOOP;
 INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details) VALUES(p_org,p_actor,'cancel_manual_sick_leave','sick_leave_request',r.id,jsonb_build_object('before',to_jsonb(r),'removed_adjustments',removed,'reason',trim(p_reason),'notification_sent',false));
 RETURN jsonb_build_object('ok',true,'removed_payroll_rows',n,'notification_sent',false);
END $$;
REVOKE ALL ON FUNCTION public.cancel_manual_sick_leave(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_manual_sick_leave(uuid,uuid,uuid,text) TO service_role;
