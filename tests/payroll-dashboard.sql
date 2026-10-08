-- Synthetic planning metadata and roster roll back; actual shifts and payroll are untouched.
BEGIN;
DO $$
DECLARE org uuid; actor uuid; emp uuid; sched uuid; shift_id uuid; d jsonb; r jsonb; fp text;
BEGIN
 SELECT organization_id,auth_user_id,id INTO org,actor,emp FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1;
 IF has_function_privilege('authenticated','public.payroll_dashboard(uuid,uuid,date,text,jsonb)','EXECUTE') OR has_table_privilege('authenticated','public.roster_day_completion','SELECT') THEN RAISE EXCEPTION 'Cost data exposed'; END IF;
 BEGIN PERFORM public.payroll_dashboard(org,gen_random_uuid(),'2002-02-01'); RAISE EXCEPTION 'Actor bypass'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Actor bypass' THEN RAISE; END IF; END;
 INSERT INTO public.shift_schedules(organization_id,week_start,status,published_snapshot) VALUES(org,'2002-02-04','draft','[]') RETURNING id INTO sched;
 INSERT INTO public.scheduled_shifts(organization_id,schedule_id,employee_id,work_date,shift_type,start_time,end_time,created_by) VALUES(org,sched,emp,'2002-02-04','day','08:00','16:00',actor) RETURNING id INTO shift_id;
 d:=public.payroll_day_plan(org,'2002-02-04',false);fp:=d->>'fingerprint';
 IF jsonb_array_length(d->'shifts')<>1 OR (d->>'complete')::boolean THEN RAISE EXCEPTION 'Draft not loaded'; END IF;
 r:=public.payroll_dashboard(org,actor,'2002-02-01','complete_day',jsonb_build_object('date','2002-02-04','expected',fp,'complete',true));
 IF NOT (r->'days'->0->>'complete')::boolean THEN RAISE EXCEPTION 'Completion not saved'; END IF;
 UPDATE public.shift_schedules SET status='published',published_snapshot=jsonb_build_array(jsonb_build_object('id',shift_id,'employee_id',emp,'work_date','2002-02-04','shift_type','day','start_time','08:00:00','end_time','16:00:00')) WHERE id=sched;
 IF NOT (public.payroll_day_plan(org,'2002-02-04',true)->>'complete')::boolean THEN RAISE EXCEPTION 'Published hash mismatch'; END IF;
 UPDATE public.scheduled_shifts SET end_time='17:00' WHERE id=shift_id;
 IF (public.payroll_day_plan(org,'2002-02-04',false)->>'complete')::boolean THEN RAISE EXCEPTION 'Edited day remains complete'; END IF;
 BEGIN PERFORM public.payroll_dashboard(org,actor,'2002-02-01','complete_day',jsonb_build_object('date','2002-02-04','expected',fp,'complete',true)); RAISE EXCEPTION 'Stale completion accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Stale completion accepted' THEN RAISE; END IF; END;
 d:=public.payroll_day_plan(org,'2002-02-05',false);
 r:=public.payroll_dashboard(org,actor,'2002-02-01','complete_day',jsonb_build_object('date','2002-02-05','expected',d->>'fingerprint','complete',true));
 IF NOT (r->'days'->1->>'complete')::boolean THEN RAISE EXCEPTION 'Intentional empty day lost'; END IF;
 r:=public.payroll_dashboard(org,actor,'2002-02-01');
 IF jsonb_array_length(r->'days')<>28 THEN RAISE EXCEPTION 'Month boundaries incorrect'; END IF;
END $$;
ROLLBACK;
