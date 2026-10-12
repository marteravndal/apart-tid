-- Synthetic fixtures are rolled back; no messages are sent and no payroll is approved.
BEGIN;
DO $$
DECLARE org uuid; actor uuid:=gen_random_uuid(); emp uuid; emp2 uuid; foreign_org uuid; schedule uuid;
 week date:=public.review_week(now())-7; shift1 uuid:=gen_random_uuid(); shift2 uuid:=gen_random_uuid(); shift3 uuid:=gen_random_uuid();
 entry uuid; auto_entry uuid; overlap_entry uuid; absence_id uuid; snap jsonb; result jsonb; a public.control_alerts%ROWTYPE; before_end timestamptz; old_fingerprint text;
BEGIN
 INSERT INTO auth.users(id,email) VALUES(actor,'control-'||actor||'@example.invalid');
 INSERT INTO public.organizations(name) VALUES('Synthetic control test - rollback') RETURNING id INTO org;
 INSERT INTO public.organizations(name) VALUES('Synthetic other org - rollback') RETURNING id INTO foreign_org;
 INSERT INTO public.employees(organization_id,auth_user_id,employee_number,full_name,email,role) VALUES(org,actor,'CONTROL-1','Synthetic Control Admin','control-admin@example.invalid','admin') RETURNING id INTO emp;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email) VALUES(org,'CONTROL-2','Synthetic Second','control-employee@example.invalid') RETURNING id INTO emp2;
 INSERT INTO public.employee_private_details(organization_id,employee_id,position_percent) VALUES(org,emp,20);
 INSERT INTO public.shift_schedules(organization_id,week_start,status,created_by) VALUES(org,week,'draft',actor) RETURNING id INTO schedule;
 INSERT INTO public.scheduled_shifts(id,schedule_id,organization_id,employee_id,work_date,shift_type,start_time,end_time,created_by)
 VALUES(shift1,schedule,org,emp,week+1,'night','23:00','07:00',actor),(shift2,schedule,org,emp,week+2,'day','06:00','10:00',actor),(shift3,schedule,org,emp2,week+4,'day','08:00','16:00',actor);
 SELECT jsonb_agg(jsonb_build_object('id',id,'employee_id',employee_id,'work_date',work_date,'start_time',start_time,'end_time',end_time)) INTO snap FROM public.scheduled_shifts WHERE schedule_id=schedule;
 UPDATE public.shift_schedules SET status='published',published_snapshot=snap WHERE id=schedule;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by)
 VALUES(org,emp,((week+1)+time '22:44') AT TIME ZONE 'Europe/Oslo',((week+2)+time '07:00') AT TIME ZONE 'Europe/Oslo','manual',actor) RETURNING id,ended_at INTO entry,before_end;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by,auto_clocked_out)
 VALUES(org,emp,((week+3)+time '08:00') AT TIME ZONE 'Europe/Oslo',((week+3)+time '20:00') AT TIME ZONE 'Europe/Oslo','manual',actor,true) RETURNING id INTO auto_entry;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by)
 VALUES(org,emp,((week+1)+time '23:00') AT TIME ZONE 'Europe/Oslo',((week+2)+time '06:00') AT TIME ZONE 'Europe/Oslo','manual',actor) RETURNING id INTO overlap_entry;
 INSERT INTO public.sick_leave_requests(organization_id,employee_id,absence_type,start_date,end_date,status,routine_version,routine_acknowledged_at)
 VALUES(org,emp,'medical_certificate',week+2,week+2,'approved','synthetic',now()) RETURNING id INTO absence_id;
 INSERT INTO public.auto_clock_notifications(organization_id,entry_id,recipient_kind,recipient,payload,created_at)
 VALUES(org,auto_entry,'employee','control@example.invalid','{}',now()-interval '10 minutes');
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp2,now()-interval '11 hours 40 minutes','manual',actor);
 result:=public.control_assistant(org,actor);
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='auto_clock') THEN RAISE EXCEPTION 'Missing auto alert'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='open_clock') THEN RAISE EXCEPTION 'Missing open clock alert'; END IF;
 IF (SELECT count(*) FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='missing_clock')<>1 THEN RAISE EXCEPTION 'Wrong missing clock / absence matching'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='time_deviation') THEN RAISE EXCEPTION 'Missing deviation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='entry_overlap') THEN RAISE EXCEPTION 'Missing entry overlap'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='plan_overlap') THEN RAISE EXCEPTION 'Missing overnight overlap'; END IF;
 IF (SELECT count(*) FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='absence_conflict')<>2 THEN RAISE EXCEPTION 'Night shift must overlap next-day absence'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='position_hours' AND (data->>'hours')::numeric=12) THEN RAISE EXCEPTION 'Wrong planned hours'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='unsent_mail') THEN RAISE EXCEPTION 'Missing unsent alert'; END IF;
 IF result::text LIKE '%national_identity_number%' OR result::text LIKE '%employee_note%' THEN RAISE EXCEPTION 'Private data leaked'; END IF;
 SELECT * INTO a FROM public.control_alerts WHERE organization_id=org AND alert_key='deviation:'||entry;
 old_fingerprint:=a.fingerprint;
 result:=public.control_assistant(org,actor,'handle',jsonb_build_object('id',a.id,'expected',a.fingerprint,'expected_status','open','comment','Checked with employee'));
 IF (SELECT ended_at FROM public.time_entries WHERE id=entry) IS DISTINCT FROM before_end OR EXISTS(SELECT 1 FROM public.weekly_item_approvals WHERE item_id=entry) THEN RAISE EXCEPTION 'Handling changed payroll'; END IF;
 PERFORM public.control_assistant(org,actor);
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE id=a.id AND status='handled') THEN RAISE EXCEPTION 'Unchanged alert reopened'; END IF;
 UPDATE public.time_entries SET ended_at=ended_at+interval '30 minutes' WHERE id=entry;
 PERFORM public.control_assistant(org,actor);
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE id=a.id AND status='open' AND fingerprint<>old_fingerprint) THEN RAISE EXCEPTION 'Changed alert not reopened'; END IF;
 BEGIN
  PERFORM public.control_assistant(org,actor,'handle',jsonb_build_object('id',a.id,'expected',old_fingerprint,'expected_status','open','comment','stale review'));
  RAISE EXCEPTION 'Stale review accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%endret%' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.control_assistant(foreign_org,actor);
  RAISE EXCEPTION 'Cross-org admin accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%ADMIN%' THEN RAISE; END IF; END;
 UPDATE public.time_entries SET started_at=((week+1)+time '23:00') AT TIME ZONE 'Europe/Oslo',ended_at=before_end WHERE id=entry;
 PERFORM public.control_assistant(org,actor);
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE id=a.id AND status='cleared' AND comment='Checked with employee') THEN RAISE EXCEPTION 'Cleared/history incorrect'; END IF;
 -- Changes to the draft must not change the published attendance comparison.
 UPDATE public.scheduled_shifts SET start_time='10:00' WHERE id=shift3;
 PERFORM public.control_assistant(org,actor);
 IF NOT EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND alert_key='missing:'||shift3 AND (data->>'planned_start')::timestamptz=((week+4)+time '08:00') AT TIME ZONE 'Europe/Oslo') THEN RAISE EXCEPTION 'Draft leaked into attendance'; END IF;
 -- A dismissed absence stops warnings (including previous night crossing midnight).
 UPDATE public.sick_leave_requests SET status='rejected' WHERE id=absence_id;
 PERFORM public.control_assistant(org,actor);
 IF EXISTS(SELECT 1 FROM public.control_alerts WHERE organization_id=org AND data->>'rule'='absence_conflict' AND status='open') THEN RAISE EXCEPTION 'Rejected absence still warned'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_type='control_alert' AND entity_id=a.id::text AND action='control_handle' AND actor_id=actor) THEN RAISE EXCEPTION 'Review audit missing'; END IF;
 IF has_function_privilege('authenticated','public.control_assistant(uuid,uuid,text,jsonb)','EXECUTE') OR has_table_privilege('anon','public.control_alerts','SELECT') OR has_function_privilege('service_role','public.scan_control_alerts()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected direct access'; END IF;
END $$;
ROLLBACK;
