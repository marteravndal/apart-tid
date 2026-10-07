-- Read-only gate used by the UI and checked again atomically on insert.
CREATE OR REPLACE FUNCTION public.clock_in_gate(p_employee_id uuid, p_organization_id uuid, p_at timestamptz DEFAULT clock_timestamp())
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE last_end timestamptz; local_day date := (p_at AT TIME ZONE 'Europe/Oslo')::date; shift_row record; next_start timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id=p_employee_id AND organization_id=p_organization_id AND active) THEN
    RETURN jsonb_build_object('allowed',false,'code','inactive','message','Brukeren er ikke aktiv. Kontakt ADMIN.');
  END IF;
  SELECT max(ended_at) INTO last_end FROM public.time_entries WHERE employee_id=p_employee_id AND organization_id=p_organization_id;
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

CREATE OR REPLACE FUNCTION public.enforce_clock_in_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE gate jsonb;
BEGIN
  -- Serialize clock-in and clock-out for one employee, including manual actions.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.employee_id::text, 73421));
  IF TG_OP='INSERT' AND NEW.source IN ('location','qr') THEN
    gate := public.clock_in_gate(NEW.employee_id,NEW.organization_id);
    IF NOT (gate->>'allowed')::boolean THEN RAISE EXCEPTION '%', gate->>'message' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_clock_in_gate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_clock_in_gate() TO service_role;
CREATE TRIGGER enforce_clock_in_gate BEFORE INSERT OR UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_clock_in_gate();
