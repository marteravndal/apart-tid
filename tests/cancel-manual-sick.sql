-- Synthetic requests only; the entire test rolls back.
BEGIN;
DO $$
DECLARE org uuid; actor uuid; emp uuid; req uuid; other_req uuid; v_case_id uuid; adjustment uuid; unrelated uuid; result jsonb;
BEGIN
 SELECT organization_id,auth_user_id INTO org,actor FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email,role,active) VALUES(org,'CANCEL-TEST-'||left(gen_random_uuid()::text,8),'Synthetic Cancellation Test',gen_random_uuid()||'@example.invalid','employee',false) RETURNING id INTO emp;
 INSERT INTO public.sick_leave_requests(organization_id,employee_id,absence_type,start_date,end_date,status,routine_version,routine_acknowledged_at,handled_by) VALUES(org,emp,'medical_certificate','2004-01-05','2004-01-09','approved','admin-manual-test',now(),actor) RETURNING id INTO req;
 INSERT INTO public.payroll_adjustments(organization_id,employee_id,work_date,category,hours,note,created_by,sick_leave_request_id) VALUES(org,emp,'2004-01-05','sick_pay',8,'Synthetic cancellation test',actor,req) RETURNING id INTO adjustment;
 INSERT INTO public.payroll_adjustments(organization_id,employee_id,work_date,category,hours,note,created_by) VALUES(org,emp,'2004-01-05','sick_pay',2,'Unrelated synthetic adjustment',actor) RETURNING id INTO unrelated;
 v_case_id:=public.ensure_sick_followup_case(req,actor);
 INSERT INTO public.sick_leave_requests(organization_id,employee_id,absence_type,start_date,end_date,status,routine_version,routine_acknowledged_at,handled_by) VALUES(org,emp,'medical_certificate','2004-01-12','2004-01-16','approved','employee-test',now(),actor) RETURNING id INTO other_req;
 IF public.ensure_sick_followup_case(other_req,actor)<>v_case_id THEN RAISE EXCEPTION 'Fixture did not merge'; END IF;
 BEGIN PERFORM public.cancel_manual_sick_leave(org,gen_random_uuid(),req,'Wrong actor'); RAISE EXCEPTION 'Unauthorized actor accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Unauthorized actor accepted' THEN RAISE; END IF; END;
 BEGIN PERFORM public.cancel_manual_sick_leave(org,actor,other_req,'Employee request'); RAISE EXCEPTION 'Nonmanual accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Nonmanual accepted' THEN RAISE; END IF; END;
 INSERT INTO public.weekly_employee_locks(organization_id,employee_id,week_start,revision,snapshot,locked_by) VALUES(org,emp,'2004-01-05',1,'{}',actor);
 BEGIN PERFORM public.cancel_manual_sick_leave(org,actor,req,'Locked test'); RAISE EXCEPTION 'Locked cancellation accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%låst uke%' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE id=adjustment) OR EXISTS(SELECT 1 FROM public.sick_leave_requests WHERE id=req AND cancelled_at IS NOT NULL) THEN RAISE EXCEPTION 'Failed cancellation changed data'; END IF;
 UPDATE public.weekly_employee_locks SET superseded_at=now(),reopened_by=actor,reopen_reason='Synthetic test' WHERE organization_id=org AND employee_id=emp;
 result:=public.cancel_manual_sick_leave(org,actor,req,'Wrong dates in synthetic test');
 IF (result->>'removed_payroll_rows')::int<>1 OR EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE id=adjustment) OR NOT EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE id=unrelated) THEN RAISE EXCEPTION 'Wrong payroll rows removed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sick_leave_requests WHERE id=req AND status='rejected' AND cancelled_at IS NOT NULL) THEN RAISE EXCEPTION 'Request not cancelled'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sick_followup_cases WHERE id=v_case_id AND status='active' AND start_date='2004-01-12' AND current_end_date='2004-01-16' AND initial_request_id=other_req) THEN RAISE EXCEPTION 'Remaining case period incorrect'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=req::text AND action='cancel_manual_sick_leave' AND jsonb_array_length(details->'removed_adjustments')=1) THEN RAISE EXCEPTION 'Audit not recorded'; END IF;
 result:=public.cancel_manual_sick_leave(org,actor,req,'Repeat test');IF NOT (result->>'already_cancelled')::boolean THEN RAISE EXCEPTION 'Not idempotent'; END IF;
 -- Last manual request closes its followup case and preserves activities.
 UPDATE public.sick_leave_requests SET routine_version='admin-manual-test' WHERE id=other_req;
 PERFORM public.cancel_manual_sick_leave(org,actor,other_req,'Last request removed');
 IF NOT EXISTS(SELECT 1 FROM public.sick_followup_cases WHERE id=v_case_id AND status='closed' AND closed_at IS NOT NULL) OR (SELECT count(*) FROM public.sick_followup_activities WHERE case_id=v_case_id AND title='Manuelt sykefravær slettet')<1 THEN RAISE EXCEPTION 'Case history lost'; END IF;
 IF has_function_privilege('authenticated','public.cancel_manual_sick_leave(uuid,uuid,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'RPC is exposed'; END IF;
END $$;
ROLLBACK;
