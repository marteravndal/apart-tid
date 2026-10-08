-- All synthetic changes roll back. No real employee week is approved by this test.
BEGIN;
DO $$
DECLARE org uuid; actor uuid; emp uuid; site uuid; ent uuid; ent2 uuid; adjustment uuid; schedule uuid; state jsonb; p jsonb; report jsonb; before_fingerprint text; old_cost numeric; record_count int; month_id uuid; emp2 uuid; future_week date;
BEGIN
 SELECT organization_id,auth_user_id INTO org,actor FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1;
 SELECT id INTO site FROM public.worksites WHERE organization_id=org AND active LIMIT 1;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email,role,active) VALUES(org,'WEEKLY-TEST-'||left(gen_random_uuid()::text,8),'Synthetic Weekly Test','weekly-test-'||gen_random_uuid()||'@example.invalid','employee',false) RETURNING id INTO emp;
 INSERT INTO public.employee_private_details(employee_id,organization_id,salary_type,salary_rate) VALUES(emp,org,'hourly',200);
 INSERT INTO public.time_entries(organization_id,employee_id,worksite_id,kind,started_at,ended_at,source,created_by) VALUES(org,emp,site,'work','2001-01-07 23:00 Europe/Oslo','2001-01-08 07:00 Europe/Oslo','manual',actor) RETURNING id INTO ent;
 BEGIN
  INSERT INTO public.month_locks(organization_id,month_start,locked_by) VALUES(org,'2001-01-01',actor);
  RAISE EXCEPTION 'Month without closed weeks accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Month without closed weeks accepted' THEN RAISE; END IF; END;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF jsonb_array_length(p->'entries')<>1 OR (p->'summary'->>'work_hours')::numeric<>8 OR (p->'summary'->>'night_hours')::numeric<>6 OR (p->'summary'->>'weekend_hours')::numeric<>1 THEN RAISE EXCEPTION 'Overnight/week/premium failure'; END IF;
 BEGIN
  PERFORM public.weekly_review(org,actor,'2001-01-01','lock_employee',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint'));
  RAISE EXCEPTION 'Unapproved lock accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Unapproved lock accepted' THEN RAISE; END IF; END;
 state:=public.weekly_review(org,actor,'2001-01-01','approve',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint','items',jsonb_build_array(jsonb_build_object('type','entry','id',ent))));
 -- Any writer must invalidate approval.
 UPDATE public.time_entries SET ended_at='2001-01-08 08:00 Europe/Oslo' WHERE id=ent;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF (p->>'unapproved')::int<>1 THEN RAISE EXCEPTION 'Edit retained approval'; END IF;
 BEGIN
  PERFORM public.weekly_review(org,actor,'2001-01-01','approve',jsonb_build_object('employee_id',emp,'expected','stale','items',jsonb_build_array(jsonb_build_object('type','entry','id',ent))));
  RAISE EXCEPTION 'Stale approval accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Stale approval accepted' THEN RAISE; END IF; END;
 INSERT INTO public.payroll_adjustments(organization_id,employee_id,work_date,category,hours,note,created_by) VALUES(org,emp,'2001-01-02','sick_pay',4,'Synthetic test',actor) RETURNING id INTO adjustment;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 state:=public.weekly_review(org,actor,'2001-01-01','approve',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint','items',jsonb_build_array(jsonb_build_object('type','entry','id',ent),jsonb_build_object('type','adjustment','id',adjustment))));
 state:=public.weekly_review(org,actor,'2001-01-01','lock_employee',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint'));
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF NOT (p->>'locked')::boolean OR (p->'summary'->>'sick_hours')::numeric<>4 THEN RAISE EXCEPTION 'Employee lock/sick calculation failure'; END IF;
 old_cost:=(p->'summary'->>'total_cost')::numeric;
 -- Fixed snapshot survives rate changes.
 UPDATE public.employee_private_details SET salary_rate=300 WHERE employee_id=emp;
 BEGIN UPDATE public.time_entries SET ended_at=ended_at+interval '1 minute' WHERE id=ent; RAISE EXCEPTION 'Locked edit accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Locked edit accepted' THEN RAISE; END IF; END;
 BEGIN DELETE FROM public.time_entries WHERE id=ent; RAISE EXCEPTION 'Locked deletion accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Locked deletion accepted' THEN RAISE; END IF; END;
 BEGIN UPDATE public.payroll_adjustments SET hours=5 WHERE id=adjustment; RAISE EXCEPTION 'Locked adjustment accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Locked adjustment accepted' THEN RAISE; END IF; END;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email,role,active) VALUES(org,'WEEKLY-OTHER-'||left(gen_random_uuid()::text,8),'Synthetic Second Employee','weekly-second-'||gen_random_uuid()||'@example.invalid','employee',false) RETURNING id INTO emp2;
 INSERT INTO public.time_entries(organization_id,employee_id,worksite_id,kind,started_at,ended_at,source,created_by) VALUES(org,emp2,site,'work','2001-01-03 12:00 Europe/Oslo','2001-01-03 13:00 Europe/Oslo','manual',actor) RETURNING id INTO ent2;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 BEGIN PERFORM public.weekly_review(org,actor,'2001-01-01','lock_week',jsonb_build_object('expected',state->>'fingerprint')); RAISE EXCEPTION 'Global incomplete lock accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Global incomplete lock accepted' THEN RAISE; END IF; END;
 DELETE FROM public.time_entries WHERE id=ent2;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 state:=public.weekly_review(org,actor,'2001-01-01','lock_week',jsonb_build_object('expected',state->>'fingerprint'));
 report:=public.weekly_review(org,actor,'2001-01-01','report');
 IF NOT (state->>'locked')::boolean OR (report->'report'->'employees'->0->'summary'->>'total_cost')::numeric<>old_cost THEN RAISE EXCEPTION 'Global lock/cost snapshot failure'; END IF;
 BEGIN INSERT INTO public.time_entries(organization_id,employee_id,worksite_id,kind,started_at,ended_at,source,created_by) VALUES(org,emp,site,'work','2001-01-03 12:00 Europe/Oslo','2001-01-03 13:00 Europe/Oslo','manual',actor); RAISE EXCEPTION 'Locked insertion accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Locked insertion accepted' THEN RAISE; END IF; END;
 INSERT INTO public.month_locks(organization_id,month_start,locked_by) VALUES(org,'2001-01-01',actor) RETURNING id INTO month_id;
 BEGIN PERFORM public.weekly_review(org,actor,'2001-01-01','reopen_week',jsonb_build_object('expected',state->>'fingerprint','reason','Synthetic blocked reopen')); RAISE EXCEPTION 'Month-locked week reopened';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Month-locked week reopened' THEN RAISE; END IF; END;
 DELETE FROM public.month_locks WHERE id=month_id;
 state:=public.weekly_review(org,actor,'2001-01-01','reopen_employee',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint','reason','Synthetic correction'));
 IF (state->>'locked')::boolean OR jsonb_array_length(state->'revisions')<>1 THEN RAISE EXCEPTION 'Reopen lost report history'; END IF;
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF (p->>'unapproved')::int<>2 THEN RAISE EXCEPTION 'Reopen did not reset approvals'; END IF;
 -- A missing planned shift must be explicitly resolved.
 INSERT INTO public.shift_schedules(organization_id,week_start,status,published_snapshot) VALUES(org,'2001-01-01','published',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'employee_id',emp,'work_date','2001-01-04','start_time','08:00','end_time','16:00'))) RETURNING id INTO schedule;
 state:=public.weekly_review(org,actor,'2001-01-01','load');
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF (p->>'missing_shifts')::int<>1 THEN RAISE EXCEPTION 'Missing planned shift not found'; END IF;
 state:=public.weekly_review(org,actor,'2001-01-01','resolve_shift',jsonb_build_object('employee_id',emp,'expected',state->>'fingerprint','shift_key',p->'shifts'->0->>'shift_key','reason','Vakten ble ikke arbeidet'));
 SELECT x INTO p FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF (p->>'missing_shifts')::int<>0 THEN RAISE EXCEPTION 'Resolution not saved'; END IF;
 IF public.review_week('2026-10-05 00:00 Europe/Oslo')<>'2026-10-05'::date THEN RAISE EXCEPTION 'Monday assigned to wrong week'; END IF;
 IF (public.weekly_premium_hours('2026-10-25 00:00 Europe/Oslo','2026-10-25 06:00 Europe/Oslo')->>'night')::numeric<>7 THEN RAISE EXCEPTION 'DST fall hours wrong'; END IF;
 IF (public.weekly_premium_hours('2026-03-29 00:00 Europe/Oslo','2026-03-29 06:00 Europe/Oslo')->>'night')::numeric<>5 THEN RAISE EXCEPTION 'DST spring hours wrong'; END IF;
 future_week:=public.review_week(now())+7;
 state:=public.weekly_review(org,actor,future_week,'load');
 IF (state->>'can_lock')::boolean THEN RAISE EXCEPTION 'Future week is lockable'; END IF;
 BEGIN PERFORM public.weekly_review(org,actor,future_week,'lock_week',jsonb_build_object('expected',state->>'fingerprint')); RAISE EXCEPTION 'Future week was locked';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%08.00%' THEN RAISE; END IF; END;
 IF has_function_privilege('authenticated','public.weekly_review(uuid,uuid,date,text,jsonb)','EXECUTE') OR has_table_privilege('anon','public.weekly_employee_locks','SELECT') THEN RAISE EXCEPTION 'Unprotected review data'; END IF;
 BEGIN PERFORM public.weekly_review(org,gen_random_uuid(),'2001-01-01','load'); RAISE EXCEPTION 'Foreign actor accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Foreign actor accepted' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
