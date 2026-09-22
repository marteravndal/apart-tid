import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import QRCode from "npm:qrcode@1.5.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const distanceMeters = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const rad = (v: number) => v * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  if (!worksite?.latitude || !worksite?.longitude) return json({ error: "Arbeidsstedet mangler posisjon." }, 503);

  if (req.method === "GET") {
    const since = new Date(Date.now() - 400 * 86400000).toISOString();
    const sinceDate = since.slice(0, 10);
    const [{ data: openEntry }, { data: entries, error }, { data: adjustments }, { data: approvals }] = await Promise.all([
      admin.from("time_entries").select("id,started_at,worksite_id").eq("employee_id", employee.id).is("ended_at", null).maybeSingle(),
      admin.from("time_entries").select("id,kind,started_at,ended_at,auto_clocked_out,source").eq("employee_id", employee.id).gte("started_at", since).order("started_at", { ascending: false }),
      admin.from("payroll_adjustments").select("work_date,category,hours,note").eq("employee_id", employee.id).gte("work_date", sinceDate).order("work_date", { ascending: false }),
      admin.from("month_approvals").select("month_start,status,approved_at").eq("employee_id", employee.id).gte("month_start", sinceDate.slice(0, 7) + "-01").order("month_start", { ascending: false }),
    ]);
    if (error) return json({ error: error.message }, 400);
    let qrStatus = null;
    if (employee.role === "admin") {
      const now = new Date().toISOString();
      const { data: activeQr } = await admin.from("qr_codes").select("id,expires_at,created_at,location_check_required").eq("worksite_id", worksite.id).is("revoked_at", null).lte("valid_from", now).gt("expires_at", now).order("created_at", { ascending: false }).limit(1).maybeSingle();
      qrStatus = activeQr;
    }
    return json({ employee: { id: employee.id, name: employee.full_name }, worksite, open_entry: openEntry, entries: entries || [], adjustments: adjustments || [], approvals: approvals || [], qr_status: qrStatus });
  }

  if (req.method !== "POST") return json({ error: "Handling støttes ikke." }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel." }, 400); }
  const action = String(body.action || "");

  if (action === "issue_qr") {
    if (employee.role !== "admin") return json({ error: "Kun administrator kan lage QR-kode." }, 403);
    const token = randomToken();
    let qrUrl: URL;
    try {
      qrUrl = new URL(String(body.base_url || ""));
      const allowedHost = qrUrl.hostname === "tid.apartstavanger.no" || qrUrl.hostname.endsWith(".vercel.app");
      if (qrUrl.protocol !== "https:" || !allowedHost || qrUrl.username || qrUrl.password) throw new Error("invalid URL");
      qrUrl.search = "";
      qrUrl.hash = "";
      qrUrl.searchParams.set("qr", token);
    } catch {
      return json({ error: "Ugyldig nettadresse for QR-koden." }, 400);
    }
    const locationCheckRequired = !qrUrl.hostname.endsWith(".vercel.app");
    const now = new Date(), expires = new Date(now);
    expires.setUTCMonth(expires.getUTCMonth() + 6);
    await admin.from("qr_codes").update({ revoked_at: now.toISOString() }).eq("worksite_id", worksite.id).is("revoked_at", null);
    const { error } = await admin.from("qr_codes").insert({ worksite_id: worksite.id, token_hash: await sha256(token), valid_from: now.toISOString(), expires_at: expires.toISOString(), created_by: authData.user.id, location_check_required: locationCheckRequired });
    if (error) return json({ error: error.message }, 400);
    const qrSvg = await QRCode.toString(qrUrl.toString(), { type: "svg", errorCorrectionLevel: "H", margin: 2, width: 420 });
    await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "issue_qr", entity_type: "worksite", entity_id: worksite.id, details: { expires_at: expires.toISOString(), location_check_required: locationCheckRequired } });
    return json({ qr_svg: qrSvg, expires_at: expires.toISOString(), worksite: worksite.name, location_check_required: locationCheckRequired }, 201);
  }

  if (action === "revoke_qr") {
    if (employee.role !== "admin") return json({ error: "Kun administrator kan sperre QR-koden." }, 403);
    const now = new Date();
    const { data: revoked, error } = await admin.from("qr_codes").update({ revoked_at: now.toISOString() }).eq("worksite_id", worksite.id).is("revoked_at", null).gt("expires_at", now.toISOString()).select("id");
    if (error) return json({ error: error.message }, 400);
    await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "revoke_qr", entity_type: "worksite", entity_id: worksite.id, details: { revoked_count: revoked?.length || 0 } });
    return json({ revoked: revoked?.length || 0 });
  }

  if (action !== "clock_in" && action !== "clock_out") return json({ error: "Ugyldig handling." }, 400);
  const latitude = Number(body.latitude), longitude = Number(body.longitude), accuracy = Number(body.accuracy);
  const rawQr = String(body.qr_token || "").replace(/^APART-TID:/, "").trim();
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !rawQr) return json({ error: "QR-kode og posisjon er påkrevd." }, 400);
  const distance = distanceMeters(latitude, longitude, worksite.latitude, worksite.longitude);
  const now = new Date();
  const { data: qr } = await admin.from("qr_codes").select("id,location_check_required").eq("worksite_id", worksite.id).eq("token_hash", await sha256(rawQr)).is("revoked_at", null).lte("valid_from", now.toISOString()).gt("expires_at", now.toISOString()).maybeSingle();
  if (!qr) return json({ error: "QR-koden er ugyldig eller utløpt." }, 403);
  if (qr.location_check_required && (!Number.isFinite(accuracy) || accuracy <= 0)) return json({ error: "Telefonen oppga ikke tilstrekkelig posisjonsnøyaktighet. Prøv igjen med posisjon aktivert." }, 403);
  if (qr.location_check_required && accuracy > 100) return json({ error: `Posisjonen er for unøyaktig (${Math.round(accuracy)} meter). Gå nærmere inngangen eller prøv igjen utendørs.`, accuracy_meters: Math.round(accuracy) }, 403);
  if (qr.location_check_required && distance > worksite.radius_meters) return json({ error: `Du er ${Math.round(distance)} meter fra arbeidsstedet. Tillatt radius er ${worksite.radius_meters} meter.`, distance_meters: Math.round(distance) }, 403);
  const { data: openEntry } = await admin.from("time_entries").select("id,started_at").eq("employee_id", employee.id).is("ended_at", null).maybeSingle();

  if (action === "clock_in") {
    if (openEntry) return json({ error: "Du er allerede stemplet inn." }, 409);
    const { data: entry, error } = await admin.from("time_entries").insert({ organization_id: employee.organization_id, employee_id: employee.id, worksite_id: worksite.id, kind: "work", started_at: now.toISOString(), clock_in_latitude: latitude, clock_in_longitude: longitude, source: "qr", created_by: authData.user.id }).select("id,started_at,ended_at").single();
    if (error) return json({ error: error.message }, 409);
    await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "clock_in", entity_type: "time_entry", entity_id: entry.id, details: { distance_meters: Math.round(distance), accuracy_meters: Number.isFinite(accuracy) ? Math.round(accuracy) : null, qr_id: qr.id, location_check_required: qr.location_check_required } });
    return json({ entry, distance_meters: Math.round(distance) }, 201);
  }
  if (!openEntry) return json({ error: "Du er ikke stemplet inn." }, 409);
  const { data: entry, error } = await admin.from("time_entries").update({ ended_at: now.toISOString(), clock_out_latitude: latitude, clock_out_longitude: longitude, updated_at: now.toISOString() }).eq("id", openEntry.id).select("id,started_at,ended_at").single();
  if (error) return json({ error: error.message }, 409);
  await admin.from("audit_logs").insert({ organization_id: employee.organization_id, actor_id: authData.user.id, action: "clock_out", entity_type: "time_entry", entity_id: entry.id, details: { distance_meters: Math.round(distance), accuracy_meters: Number.isFinite(accuracy) ? Math.round(accuracy) : null, qr_id: qr.id, location_check_required: qr.location_check_required } });
  return json({ entry, distance_meters: Math.round(distance) });
});
