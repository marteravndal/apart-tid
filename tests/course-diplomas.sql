-- Integration checks roll back all test records and file metadata. No storage objects are created.
BEGIN;
DO $$
DECLARE e public.employees%ROWTYPE; course_id uuid; test_assignment uuid; d public.course_diplomas%ROWTYPE;
  result jsonb; doc uuid; again uuid; snap jsonb; attempts_before integer;
BEGIN
  SELECT * INTO e FROM public.employees WHERE active AND auth_user_id IS NOT NULL LIMIT 1;
  IF e.id IS NULL THEN RAISE EXCEPTION 'Test requires one authenticated employee.'; END IF;
  INSERT INTO public.courses(organization_id,title,status,passing_score,modules,questions)
    VALUES(e.organization_id,'Synthetic diploma integration test','locked',80,'[]','[]') RETURNING id INTO course_id;
  INSERT INTO public.course_assignments(organization_id,course_id,employee_id)
    VALUES(e.organization_id,course_id,e.id) RETURNING id INTO test_assignment;
  result:=public.record_course_attempt(test_assignment,e.id,e.organization_id,e.auth_user_id,20,false,'[]');
  IF (result->>'passed')::boolean OR EXISTS(SELECT 1 FROM public.course_diplomas WHERE course_diplomas.assignment_id=test_assignment)
    THEN RAISE EXCEPTION 'Failed attempt produced diploma'; END IF;
  result:=public.record_course_attempt(test_assignment,e.id,e.organization_id,e.auth_user_id,100,true,'[]');
  SELECT * INTO STRICT d FROM public.course_diplomas WHERE course_diplomas.assignment_id=test_assignment;
  snap:=d.snapshot;
  IF snap->>'employee_name'<>e.full_name OR (snap->>'course_version')::integer<>1 THEN RAISE EXCEPTION 'Wrong snapshot'; END IF;
  result:=public.record_course_attempt(test_assignment,e.id,e.organization_id,e.auth_user_id,0,false,'[]');
  IF NOT (result->>'passed')::boolean OR (result->>'score')::integer<>100 THEN RAISE EXCEPTION 'Passed result was overwritten'; END IF;
  SELECT attempts INTO attempts_before FROM public.course_assignments WHERE id=test_assignment;
  IF attempts_before<>2 THEN RAISE EXCEPTION 'Duplicate attempt was recorded'; END IF;
  BEGIN
    UPDATE public.course_diplomas SET snapshot='{}' WHERE id=d.id;
    RAISE EXCEPTION 'Snapshot mutation accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='Snapshot mutation accepted' THEN RAISE; END IF;
  END;
  doc:=public.finalize_course_diploma(d.id,e.organization_id,e.organization_id||'/course-diplomas/'||d.id||'/test.pdf',1234);
  again:=public.finalize_course_diploma(d.id,e.organization_id,e.organization_id||'/course-diplomas/'||d.id||'/retry.pdf',1234);
  IF doc<>again THEN RAISE EXCEPTION 'Duplicate archive entry'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.hr_documents WHERE id=doc AND employee_id=e.id AND provider='apart_tid_course_diploma' AND NOT requires_signature)
    THEN RAISE EXCEPTION 'Invalid archive entry'; END IF;
  DELETE FROM public.hr_documents WHERE id=doc;
  IF EXISTS(SELECT 1 FROM public.course_diplomas WHERE id=d.id AND document_id IS NOT NULL) THEN RAISE EXCEPTION 'Delete link not cleared'; END IF;
  again:=public.finalize_course_diploma(d.id,e.organization_id,e.organization_id||'/course-diplomas/'||d.id||'/recreated.pdf',1234);
  IF again=doc OR (SELECT snapshot FROM public.course_diplomas WHERE id=d.id)<>snap THEN RAISE EXCEPTION 'Recreation changed evidence'; END IF;
  IF has_table_privilege('authenticated','public.course_diplomas','SELECT')
    OR has_function_privilege('authenticated','public.finalize_course_diploma(uuid,uuid,text,integer)','EXECUTE')
    OR has_function_privilege('anon','public.record_course_attempt(uuid,uuid,uuid,uuid,integer,boolean,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'Direct client access is not allowed'; END IF;
END;
$$;
ROLLBACK;
