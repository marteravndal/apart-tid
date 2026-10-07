-- Completion evidence is captured in the same transaction as a passed course.
CREATE TABLE public.course_diplomas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  assignment_id uuid NOT NULL UNIQUE REFERENCES public.course_assignments(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  snapshot jsonb NOT NULL,
  document_id uuid UNIQUE REFERENCES public.hr_documents(id) ON DELETE SET NULL,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_diplomas_org_employee ON public.course_diplomas(organization_id,employee_id);
ALTER TABLE public.course_diplomas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.course_diplomas FROM anon,authenticated;
GRANT ALL ON public.course_diplomas TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.course_diplomas_reference_no_seq TO service_role;

CREATE FUNCTION public.capture_course_diploma() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status='completed' AND NEW.completed_at IS NOT NULL THEN
    INSERT INTO public.course_diplomas(assignment_id,organization_id,employee_id,snapshot)
    SELECT NEW.id,NEW.organization_id,NEW.employee_id,
      jsonb_build_object('employee_name',e.full_name,'course_title',c.title,'course_version',c.version,
        'completed_at',NEW.completed_at,'issuer','Apart Stavanger AS','template_version',1)
    FROM public.courses c JOIN public.employees e ON e.id=NEW.employee_id AND e.organization_id=NEW.organization_id
    WHERE c.id=NEW.course_id AND c.organization_id=NEW.organization_id
    ON CONFLICT(assignment_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_course_diploma() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_course_diploma() TO service_role;
CREATE TRIGGER capture_course_diploma AFTER INSERT OR UPDATE OF status,completed_at ON public.course_assignments
FOR EACH ROW EXECUTE FUNCTION public.capture_course_diploma();

-- Existing completions retain their original date, rather than the migration date.
INSERT INTO public.course_diplomas(assignment_id,organization_id,employee_id,snapshot)
SELECT a.id,a.organization_id,a.employee_id,
  jsonb_build_object('employee_name',e.full_name,'course_title',c.title,'course_version',c.version,
    'completed_at',a.completed_at,'issuer','Apart Stavanger AS','template_version',1)
FROM public.course_assignments a
JOIN public.courses c ON c.id=a.course_id AND c.organization_id=a.organization_id
JOIN public.employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id
WHERE a.status='completed' AND a.completed_at IS NOT NULL
ON CONFLICT(assignment_id) DO NOTHING;

CREATE FUNCTION public.guard_course_diploma_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.reference_no,NEW.assignment_id,NEW.organization_id,NEW.employee_id,NEW.snapshot,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.reference_no,OLD.assignment_id,OLD.organization_id,OLD.employee_id,OLD.snapshot,OLD.created_at)
  THEN RAISE EXCEPTION 'Et utstedt kursdiplom kan ikke endres.'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_course_diploma_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_course_diploma_snapshot() TO service_role;
CREATE TRIGGER guard_course_diploma_snapshot BEFORE UPDATE ON public.course_diplomas
FOR EACH ROW EXECUTE FUNCTION public.guard_course_diploma_snapshot();

-- Lock completion so concurrent/retried submissions cannot overwrite a passed test.
CREATE FUNCTION public.record_course_attempt(p_assignment_id uuid,p_employee_id uuid,p_organization_id uuid,
  p_actor_id uuid,p_score integer,p_passed boolean,p_answers jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE a public.course_assignments%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.course_assignments WHERE id=p_assignment_id AND employee_id=p_employee_id
    AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.employees WHERE id=p_employee_id AND organization_id=p_organization_id AND auth_user_id=p_actor_id AND active)
    THEN RAISE EXCEPTION 'Kurset er ikke tilgjengelig.'; END IF;
  IF a.status='completed' THEN RETURN jsonb_build_object('score',a.score,'passed',true); END IF;
  IF p_score NOT BETWEEN 0 AND 100 OR p_score IS NULL OR p_passed IS NULL THEN RAISE EXCEPTION 'Ugyldig resultat.'; END IF;
  INSERT INTO public.course_attempts(assignment_id,employee_id,score,passed,answers)
    VALUES(a.id,a.employee_id,p_score,p_passed,p_answers);
  UPDATE public.course_assignments SET attempts=coalesce(attempts,0)+1,score=p_score,
    status=CASE WHEN p_passed THEN 'completed' ELSE 'in_progress' END,
    started_at=coalesce(started_at,now()),completed_at=CASE WHEN p_passed THEN now() ELSE NULL END
    WHERE id=a.id;
  INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
    VALUES(a.organization_id,p_actor_id,CASE WHEN p_passed THEN 'complete_course' ELSE 'attempt_course' END,
      'course_assignment',a.id::text,jsonb_build_object('score',p_score,'passed',p_passed));
  RETURN jsonb_build_object('score',p_score,'passed',p_passed);
END;
$$;
REVOKE ALL ON FUNCTION public.record_course_attempt(uuid,uuid,uuid,uuid,integer,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_course_attempt(uuid,uuid,uuid,uuid,integer,boolean,jsonb) TO service_role;

-- Only publish an archive entry after its private PDF upload succeeds.
CREATE FUNCTION public.finalize_course_diploma(p_id uuid,p_organization_id uuid,p_storage_path text,p_size_bytes integer)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE d public.course_diplomas%ROWTYPE; doc_id uuid; ref text;
BEGIN
  SELECT * INTO d FROM public.course_diplomas WHERE id=p_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Diplomet finnes ikke.'; END IF;
  IF d.document_id IS NOT NULL THEN RETURN d.document_id; END IF;
  IF p_storage_path NOT LIKE d.organization_id::text||'/course-diplomas/'||d.id::text||'/%'
    OR p_storage_path IS NULL THEN RAISE EXCEPTION 'Ugyldig lagringssti.'; END IF;
  ref:='KURS-'||to_char((d.snapshot->>'completed_at')::timestamptz AT TIME ZONE 'Europe/Oslo','YYYY')||'-'||lpad(d.reference_no::text,6,'0');
  INSERT INTO public.hr_documents(organization_id,employee_id,title,document_type,storage_path,original_name,mime_type,size_bytes,provider)
    VALUES(d.organization_id,d.employee_id,left('Kursdiplom – '||(d.snapshot->>'course_title'),200),'other',p_storage_path,
      ref||'.pdf','application/pdf',p_size_bytes,'apart_tid_course_diploma') RETURNING id INTO doc_id;
  UPDATE public.course_diplomas SET document_id=doc_id,issued_at=coalesce(issued_at,now()) WHERE id=d.id;
  INSERT INTO public.audit_logs(organization_id,action,entity_type,entity_id,details)
    VALUES(d.organization_id,'issue_course_diploma','course_diploma',d.id::text,
      jsonb_build_object('assignment_id',d.assignment_id,'document_id',doc_id,'reference',ref));
  RETURN doc_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_course_diploma(uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_course_diploma(uuid,uuid,text,integer) TO service_role;
