import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import QRCode from "npm:qrcode@1.5.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const distanceMeters = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const rad = (v: number) => v * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Mangler innlogging." }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!serviceKey) return json({ error: "Tjenesten er ikke konfigurert." }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(authHeader.slice(7));
  if (authError || !authData.user) return json({ error: "Ugyldig innlogging." }, 401);
  const { data: employee } = await admin.from("employees").select("id,organization_id,employee_number,full_name,role,active").eq("auth_user_id", authData.user.id).maybeSingle();
  if (!employee?.active) return json({ error: "Brukeren er ikke aktiv." }, 403);
  const { data: worksite } = await admin.from("worksites").select("id,name,address,latitude,longitude,radius_meters").eq("organization_id", employee.organization_id).eq("active", true).limit(1).maybeSingle();
  if (!worksite || worksite.latitude == null || worksite.longitude == null || !Number.isFinite(Number(worksite.latitude)) || !Number.isFinite(Number(worksite.longitude)) || !Number.isFinite(Number(worksite.radius_meters)) || Number(worksite.radius_meters) <= 0) return json({ error: "Arbeidsstedet mangler posisjon." }, 503);

  if (req.method === "GET") {
    const since = new Date(Date.now() - 400 * 86400000).toISOString();
    const sinceDate = since.slice(0, 10);
    const [{ data: openEntry, error: statusError }, { data: entries, error }, { data: adjustments }, { data: approvals }] = await Promise.all([
      admin.from("time_entries").select("id,started_at,worksite_id").eq("employee_id", employee.id).is("ended_at", null).maybeSingle(),
      admin.from("time_entries").select("id,kind,started_at,ended_at,auto_clocked_out,source").eq("employee_id", employee.id).gte("started_at", since).order("started_at", { ascending: false }),
      admin.from("payroll_adjustments").select("work_date,category,hours,note").eq("employee_id", employee.id).gte("work_date", sinceDate).order("work_date", { ascending: false }),
      admin.from("month_approvals").select("month_start,status,approved_at").eq("employee_id", employee.id).gte("month_start", sinceDate.slice(0, 7) + "-01").order("month_start", { ascending: false }),
    ]);
    if (error || statusError) return json({ error: "Timelisten kunne ikke hentes. Prøv igjen." }, 503);
    const { data: gate, error: gateError } = openEntry ? { data: null, error: null } : await admin.rpc("clock_in_gate", { p_employee_id: employee.id, p_organization_id: employee.organization_id });
    if (gateError) return json({ error: "Kunne ikke kontrollere vaktlisten. Prøv igjen." }, 503);
    return json({ clock_in_gate: gate, employee: { id: employee.id, name: employee.full_name }, worksite, open_entry: openEntry, entries: entries || [], adjustments: adjustments || [], approvals: approvals || [] });
  }

  if (req.method !== "POST") return json({ error: "Handling støttes ikke." }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel." }, 400); }
  const action = String(body.action || "");

  // The poster is only a public shortcut. It grants no attendance permissions.
  if (action === "issue_qr") {
    if (employee.role !== "admin") return json({ error: "Kun administrator kan lage QR-kode." }, 403);
    const qrUrl = "https://tid.apartstavanger.no/";
    const qrSvg = await QRCode.toString(qrUrl, { type: "svg", errorCorrectionLevel: "H", margin: 2, width: 420 });
    return json({ qr_svg: qrSvg, url: qrUrl, worksite: worksite.name }, 200);
  }

  if (!["clock_in", "clock_out", "check_position"].includes(action)) return json({ error: "Ugyldig handling." }, 400);
  // Old cached clients must not auto-stamp when they open a QR link.
  if (body.qr_token || body.reserve_code) return json({ error: "Stempling er forenklet. Oppdater Apart Tid og bruk knappen Stemple inn eller Stemple ut." }, 409);
  const latitude = body.latitude, longitude = body.longitude, accuracy = body.accuracy;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return json({ error: "Posisjonen mangler. Tillat posisjon for Apart Tid og prøv igjen." }, 400);
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy <= 0) return json({ error: "Enheten oppga ikke posisjonsnøyaktighet. Aktiver nøyaktig posisjon og prøv igjen." }, 403);
  const positionTimestamp = body.position_timestamp;
  if (typeof positionTimestamp !== "number" || !Number.isFinite(positionTimestamp) || Date.now() - positionTimestamp > 120000 || positionTimestamp - Date.now() > 30000) return json({ error: "Posisjonen er for gammel eller ugyldig. Prøv igjen for å hente en ny posisjon." }, 403);
  const distance = distanceMeters(latitude, longitude, Number(worksite.latitude), Number(worksite.longitude));
  if (accuracy > 100) return json({ error: `Vi klarer ikke å bekrefte hvor du er. Posisjonen er for unøyaktig (${Math.round(accuracy)} meter). Prøv nær et vindu eller kontakt administrator.`, accuracy_meters: Math.round(accuracy) }, 403);
  if (distance > Number(worksite.radius_meters)) return json({ error: `Du må være på arbeidsstedet. Målt avstand er ${Math.round(distance)} meter; tillatt område er ${worksite.radius_meters} meter.`, distance_meters: Math.round(distance) }, 403);
  if (action === "check_position") return json({ valid: true, distance_meters: Math.round(distance), accuracy_meters: Math.round(accuracy) });
  const now = new Date();
  const { data: openEntry, error: openError } = await admin.from("time_entries").select("id,started_at").eq("employee_id", employee.id).is("ended_at", null).maybeSingle();
  if (openError) return json({ error: "Kunne ikke kontrollere stemplingsstatus. Prøv igjen." }, 503);

  if (action === "clock_in") {
    if (openEntry) return json({ error: "Du er allerede stemplet inn." }, 409);
    const { data: gate, error: gateError } = await admin.rpc("clock_in_gate", { p_employee_id: employee.id, p_organization_id: employee.organization_id });
    if (gateError || !gate) return json({ error: "Kunne ikke kontrollere vaktlisten. Prøv igjen." }, 503);
    if (!gate.allowed) return json({ error: gate.message, clock_in_gate: gate }, 409);
    const { data: entry, error } = await admin.from("time_entries").insert({ organization_id: employee.organization_id, employee_id: employee.id, worksite_id: worksite.id, kind: "work", started_at: now.toISOString(), clock_in_latitude: latitude, clock_in_longitude: longitude, source: "location", created_by: authData.user.id }).select("id,started_at,ended_at").single();
    if (error) return json({ error: error.message }, 409);
    await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "clock_in", entity_type: "time_entry", entity_id: entry.id, details: { distance_meters: Math.round(distance), accuracy_meters: Number.isFinite(accuracy) ? Math.round(accuracy) : null, method: "location", location_check_required: true } });
    return json({ entry, distance_meters: Math.round(distance) }, 201);
  }
  if (!openEntry || body.open_entry_id !== openEntry.id) return json({ error: "Stemplingsstatusen er endret. Oppdater siden før du prøver igjen." }, 409);
  const { data: entry, error } = await admin.from("time_entries").update({ ended_at: now.toISOString(), clock_out_latitude: latitude, clock_out_longitude: longitude, updated_at: now.toISOString() }).eq("id", openEntry.id).is("ended_at", null).select("id,started_at,ended_at").maybeSingle();
  if (error) return json({ error: error.message }, 409);
  if (!entry) return json({ error: "Du er allerede stemplet ut. Oppdater siden." }, 409);
  await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "clock_out", entity_type: "time_entry", entity_id: entry.id, details: { distance_meters: Math.round(distance), accuracy_meters: Number.isFinite(accuracy) ? Math.round(accuracy) : null, method: "location", location_check_required: true } });
  return json({ entry, distance_meters: Math.round(distance) });
});
