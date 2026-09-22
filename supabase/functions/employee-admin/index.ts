import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const sendInvitation = async (employee: { full_name: string; email: string }) => {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const appUrl = Deno.env.get("APP_URL") || "https://tid.apartstavanger.no";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `employee-invitation-${employee.email.toLowerCase()}` },
      body: JSON.stringify({
        from: "Apart Tid <post@apartstavanger.no>", to: [employee.email], subject: "Velkommen til Apart Tid",
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.55;color:#17211f"><h2>Velkommen til Apart Tid</h2><p>Hei ${esc(employee.full_name)}.</p><p>Du er invitert til Apart Tid, systemet vi bruker til arbeidstid, ferie, fravær og HR-dokumenter.</p><h3>Slik logger du inn</h3><ol><li>Åpne <a href="${appUrl}">${appUrl}</a>.</li><li>Skriv inn e-postadressen denne invitasjonen ble sendt til.</li><li>Du mottar en engangskode på e-post. Skriv inn koden for å logge inn.</li></ol><h3>Stemple inn og ut</h3><ol><li>Åpne Apart Tid på telefonen.</li><li>Trykk på knappen for å skanne QR-koden på arbeidsstedet.</li><li>Tillat posisjon når telefonen spør. Posisjonen kontrolleres bare når du stempler.</li><li>Skann koden for å stemple inn. Gjenta når du skal stemple ut.</li></ol><p>Ta kontakt med administrasjonen dersom du ikke mottar innloggingskoden eller trenger hjelp.</p><p>Vennlig hilsen<br>Apart Stavanger AS</p></div>`,
      }),
    });
    return response.ok;
  } catch { return false; }
};

const validRole = (value: unknown): value is "employee" | "manager" | "admin" =>
  value === "employee" || value === "manager" || value === "admin";

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const nullableText = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max) || null;
const privateDetails = (body: Record<string, unknown>, fallback: Record<string, unknown> = {}) => {
  const value = (key: string) => body[key] === undefined ? fallback[key] : body[key];
  const postalCode = digits(value("postal_code")) || null;
  const bankAccount = digits(value("bank_account")) || null;
  const nationalId = digits(value("national_identity_number")) || null;
  const employedFrom = nullableText(value("employed_from"), 10);
  const positionRaw = value("position_percent");
  const salaryRaw = value("salary_rate");
  const positionPercent = positionRaw === null || positionRaw === "" || positionRaw === undefined ? null : Number(positionRaw);
  const salaryRate = salaryRaw === null || salaryRaw === "" || salaryRaw === undefined ? null : Number(salaryRaw);
  const salaryType = nullableText(value("salary_type"), 20);
  if (postalCode && !/^\d{4}$/.test(postalCode)) throw new Error("Postnummer må ha fire sifre.");
  if (bankAccount && !/^\d{11}$/.test(bankAccount)) throw new Error("Kontonummer må ha elleve sifre.");
  if (nationalId && !/^\d{11}$/.test(nationalId)) throw new Error("Personnummer må ha elleve sifre.");
  if (employedFrom && !/^\d{4}-\d{2}-\d{2}$/.test(employedFrom)) throw new Error("Kontroller datoen for ansatt fra.");
  if (positionPercent !== null && (!Number.isFinite(positionPercent) || positionPercent <= 0 || positionPercent > 100)) throw new Error("Stillingsgrad må være mellom 0 og 100 prosent.");
  if (salaryType && salaryType !== "hourly" && salaryType !== "monthly") throw new Error("Velg timelønn eller fastlønn.");
  if (salaryRate !== null && (!Number.isFinite(salaryRate) || salaryRate < 0)) throw new Error("Lønnssatsen kan ikke være negativ.");
  return { address: nullableText(value("address")), postal_code: postalCode, city: nullableText(value("city"), 120), bank_account: bankAccount, national_identity_number: nationalId, employed_from: employedFrom, position_percent: positionPercent, salary_type: salaryType, salary_rate: salaryRate };
};
const employeeReportPdf = async (employee: Record<string, any>) => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]), dark = rgb(.06, .14, .12), muted = rgb(.35, .35, .35);
  page.drawText("ANSATTOPPLYSNINGER", { x: 55, y: 775, size: 20, font: bold, color: dark });
  page.drawText("Konfidensielt personaldokument", { x: 55, y: 752, size: 9, font, color: muted });
  const role = ({ employee: "Ansatt", manager: "Avdelingsleder", admin: "Administrator" } as Record<string,string>)[employee.role] || employee.role;
  const salaryType = employee.salary_type === "hourly" ? "Timelønn" : employee.salary_type === "monthly" ? "Fastlønn per måned" : "Ikke registrert";
  const rate = employee.salary_rate == null ? "Ikke registrert" : `${Number(employee.salary_rate).toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
  const rows = [
    ["Navn", employee.full_name], ["Ansattnummer", employee.employee_number], ["Personnummer", employee.national_identity_number],
    ["Adresse", employee.address], ["Postnummer og sted", [employee.postal_code, employee.city].filter(Boolean).join(" ")],
    ["E-post", employee.email], ["Telefon", employee.phone_number], ["Kontonummer", employee.bank_account],
    ["Ansatt fra", employee.employed_from], ["Stillingsgrad", employee.position_percent == null ? null : `${employee.position_percent} %`],
    ["Lønnsform", salaryType], ["Lønnssats", rate], ["Systemrolle", role], ["Status", employee.active ? "Aktiv" : "Inaktiv"],
  ];
  let y = 705;
  for (const [label, raw] of rows) {
    page.drawText(String(label), { x: 55, y, size: 9, font: bold, color: muted });
    page.drawText(String(raw || "Ikke registrert"), { x: 220, y, size: 10.5, font, color: dark });
    page.drawLine({ start: { x: 55, y: y - 9 }, end: { x: 540, y: y - 9 }, thickness: .35, color: rgb(.82, .84, .83) });
    y -= 36;
  }
  page.drawText(`Generert ${new Date().toLocaleString("nb-NO", { timeZone: "Europe/Oslo" })}`, { x: 55, y: 35, size: 8.5, font, color: muted });
  const bytes = await pdf.save(); let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(binary);
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Mangler innlogging." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!serviceKey) return json({ error: "Tjenesten er ikke konfigurert." }, 500);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const token = authHeader.slice(7);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user?.email) return json({ error: "Ugyldig innlogging." }, 401);
  const currentUser = authData.user;
  const { data: currentEmployee } = await admin
    .from("employees")
    .select("id, organization_id, role, active")
    .eq("auth_user_id", currentUser.id)
    .maybeSingle();

  let body: Record<string, unknown> = {};
  if (req.method !== "GET") {
    try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel." }, 400); }
  }
  const action = String(body.action || "");

  if (action === "bootstrap") {
    if (currentEmployee) {
      await admin.auth.admin.updateUserById(currentUser.id, {
        app_metadata: { role: currentEmployee.role },
      });
      return json({ employee: currentEmployee });
    }
    const { data: recipient } = await admin
      .from("report_recipients")
      .select("organization_id, email")
      .eq("recipient_type", "admin")
      .ilike("email", currentUser.email)
      .maybeSingle();
    if (!recipient) return json({ error: "E-postadressen er ikke godkjent som første administrator." }, 403);
    const { data: employee, error } = await admin.from("employees").insert({
      organization_id: recipient.organization_id,
      auth_user_id: currentUser.id,
      employee_number: "ADMIN",
      full_name: String(currentUser.user_metadata?.full_name || "Administrator"),
      email: currentUser.email.toLowerCase(),
      role: "admin",
      active: true,
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    await admin.auth.admin.updateUserById(currentUser.id, { app_metadata: { role: "admin" } });
    await admin.from("audit_logs").insert({
      organization_id: recipient.organization_id,
      actor_id: currentUser.id,
      action: "bootstrap_admin",
      entity_type: "employee",
      entity_id: employee.id,
    });
    return json({ employee }, 201);
  }

  if (!currentEmployee?.active || currentEmployee.role !== "admin") {
    return json({ error: "Kun aktiv administrator har tilgang." }, 403);
  }

  if (req.method === "GET") {
    const [{ data, error }, { data: entries, error: entriesError }, { data: detailRows, error: detailsError }] = await Promise.all([
      admin.from("employees").select("id, employee_number, full_name, email, phone_number, role, active, created_at, deactivated_at, invited_at").eq("organization_id", currentEmployee.organization_id).order("active", { ascending: false }).order("full_name"),
      admin.from("time_entries").select("id,employee_id,started_at,ended_at,source,auto_clocked_out").eq("organization_id", currentEmployee.organization_id).order("started_at", { ascending: false }).limit(500),
      admin.from("employee_private_details").select("employee_id,address,postal_code,city,bank_account,national_identity_number,employed_from,position_percent,salary_type,salary_rate").eq("organization_id", currentEmployee.organization_id),
    ]);
    if (error || entriesError || detailsError) return json({ error: error?.message || entriesError?.message || detailsError?.message }, 400);
    const statusByEmployee = new Map<string, { open_entry: unknown; last_entry: unknown }>();
    for (const entry of entries || []) {
      const status = statusByEmployee.get(entry.employee_id) || { open_entry: null, last_entry: null };
      if (!status.last_entry) status.last_entry = entry;
      if (!entry.ended_at && !status.open_entry) status.open_entry = entry;
      statusByEmployee.set(entry.employee_id, status);
    }
    const detailsByEmployee = new Map((detailRows || []).map((row) => [row.employee_id, row]));
    return json({ employees: (data || []).map((employee) => { const details = detailsByEmployee.get(employee.id) || {}; const { employee_id: _, ...safeDetails } = details as any; return ({ ...employee, ...safeDetails, ...(statusByEmployee.get(employee.id) || { open_entry: null, last_entry: null }) }); }) });
  }

  if (req.method === "POST" && action === "employee_report_pdf") {
    const id = String(body.employee_id || "");
    const { data: employee } = await admin.from("employees").select("id,employee_number,full_name,email,phone_number,role,active").eq("id", id).eq("organization_id", currentEmployee.organization_id).maybeSingle();
    if (!employee) return json({ error: "Fant ikke den ansatte." }, 404);
    const { data: details } = await admin.from("employee_private_details").select("address,postal_code,city,bank_account,national_identity_number,employed_from,position_percent,salary_type,salary_rate").eq("employee_id", id).maybeSingle();
    const content_base64 = await employeeReportPdf({ ...employee, ...(details || {}) });
    await admin.from("audit_logs").insert({ organization_id: currentEmployee.organization_id, actor_id: currentUser.id, action: "download_employee_report_pdf", entity_type: "employee", entity_id: id });
    return json({ content_base64, file_name: `ansattopplysninger-${employee.employee_number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf` });
  }

  if (req.method === "POST" && action === "invite") {
    const id = String(body.employee_id || "");
    const { data: employee } = await admin.from("employees").select("id,auth_user_id,full_name,email,role,active,invited_at").eq("id", id).eq("organization_id", currentEmployee.organization_id).maybeSingle();
    if (!employee) return json({ error: "Fant ikke den ansatte." }, 404);
    if (!employee.active) return json({ error: "Den ansatte må være aktiv før invitasjon sendes." }, 409);
    if (employee.invited_at) return json({ error: "Den ansatte er allerede invitert." }, 409);
    let authUserId = employee.auth_user_id;
    if (!authUserId) {
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email: employee.email, email_confirm: true, app_metadata: { role: employee.role }, user_metadata: { full_name: employee.full_name } });
      if (createError || !created.user) return json({ error: createError?.message || "Kunne ikke opprette innlogging." }, 400);
      authUserId = created.user.id;
      const linkResult = await admin.from("employees").update({ auth_user_id: authUserId, updated_at: new Date().toISOString() }).eq("id", id).is("auth_user_id", null);
      if (linkResult.error) { await admin.auth.admin.deleteUser(authUserId); return json({ error: "Innloggingen kunne ikke kobles til den ansatte." }, 400); }
    }
    const emailSent = await sendInvitation(employee);
    if (!emailSent) return json({ error: "Innloggingen er klargjort, men invitasjonen kunne ikke sendes. Prøv igjen." }, 502);
    const invitedAt = new Date().toISOString();
    const result = await admin.from("employees").update({ invited_at: invitedAt, invited_by: currentUser.id, updated_at: invitedAt }).eq("id", id).is("invited_at", null).select("id,invited_at").maybeSingle();
    if (result.error || !result.data) return json({ error: "Invitasjonen ble sendt, men statusen kunne ikke oppdateres." }, 500);
    await admin.from("audit_logs").insert({ organization_id: currentEmployee.organization_id, actor_id: currentUser.id, action: "invite_employee", entity_type: "employee", entity_id: id, details: { email: employee.email } });
    return json({ invited_at: invitedAt, email_sent: true });
  }

  if (req.method === "POST" && action === "manual_clock") {
    const employeeId = String(body.employee_id || ""), clockAction = String(body.clock_action || ""), reason = String(body.reason || "").trim();
    if ((clockAction !== "clock_in" && clockAction !== "clock_out") || reason.length < 3) return json({ error: "Velg inn- eller utstempling og skriv en begrunnelse." }, 400);
    const { data: target } = await admin.from("employees").select("id,active,full_name").eq("id", employeeId).eq("organization_id", currentEmployee.organization_id).maybeSingle();
    if (!target) return json({ error: "Fant ikke den ansatte." }, 404);
    if (!target.active) return json({ error: "Inaktive ansatte kan ikke stemples." }, 409);
    const osloDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
    const { data: lockedReport } = await admin.from("daily_reports").select("id").eq("organization_id", currentEmployee.organization_id).eq("work_date", osloDate).eq("status", "locked").maybeSingle();
    if (lockedReport) return json({ error: "Dagens rapport er låst og kan ikke endres." }, 409);
    const { data: openEntry } = await admin.from("time_entries").select("id,note").eq("employee_id", employeeId).is("ended_at", null).maybeSingle();
    const now = new Date().toISOString();
    let entry;
    if (clockAction === "clock_in") {
      if (openEntry) return json({ error: "Den ansatte er allerede stemplet inn." }, 409);
      const { data: worksite } = await admin.from("worksites").select("id").eq("organization_id", currentEmployee.organization_id).eq("active", true).limit(1).maybeSingle();
      if (!worksite) return json({ error: "Aktivt arbeidssted mangler." }, 409);
      const result = await admin.from("time_entries").insert({ organization_id: currentEmployee.organization_id, employee_id: employeeId, worksite_id: worksite.id, kind: "work", started_at: now, source: "manual", note: `Manuell innstempling: ${reason}`, created_by: currentUser.id }).select("id,started_at,ended_at").single();
      if (result.error) return json({ error: result.error.message }, 400);
      entry = result.data;
    } else {
      if (!openEntry) return json({ error: "Den ansatte er ikke stemplet inn." }, 409);
      const note = [openEntry.note, `Manuell utstempling: ${reason}`].filter(Boolean).join("\n");
      const result = await admin.from("time_entries").update({ ended_at: now, note, updated_at: now }).eq("id", openEntry.id).select("id,started_at,ended_at").single();
      if (result.error) return json({ error: result.error.message }, 400);
      entry = result.data;
    }
    await admin.from("audit_logs").insert({ organization_id: currentEmployee.organization_id, actor_id: currentUser.id, action: clockAction === "clock_in" ? "manual_clock_in" : "manual_clock_out", entity_type: "time_entry", entity_id: entry.id, details: { employee_id: employeeId, employee_name: target.full_name, reason } });
    return json({ entry, employee: target });
  }

  if (req.method === "POST" && action === "create") {
    const employeeNumber = String(body.employee_number || "").trim();
    const fullName = String(body.full_name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone_number || "").trim() || null;
    const role = body.role;
    let details; try { details = privateDetails(body); } catch (error) { return json({ error: (error as Error).message }, 400); }
    if (!employeeNumber || !fullName || !/^\S+@\S+\.\S+$/.test(email) || !validRole(role)) {
      return json({ error: "Kontroller ansattnummer, navn, e-post og rolle." }, 400);
    }
    const { data: employee, error } = await admin.from("employees").insert({
      organization_id: currentEmployee.organization_id,
      employee_number: employeeNumber,
      full_name: fullName,
      email,
      phone_number: phone,
      role,
      active: true,
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    const detailResult = await admin.from("employee_private_details").insert({ employee_id: employee.id, organization_id: currentEmployee.organization_id, ...details, updated_by: currentUser.id });
    if (detailResult.error) { await admin.from("employees").delete().eq("id", employee.id); return json({ error: detailResult.error.message }, 400); }
    await admin.from("audit_logs").insert({
      organization_id: currentEmployee.organization_id,
      actor_id: currentUser.id,
      action: "create_employee",
      entity_type: "employee",
      entity_id: employee.id,
      details: { employee_number: employeeNumber, role },
    });
    return json({ employee: { ...employee, ...details } }, 201);
  }

  if (req.method === "PATCH" && action === "update") {
    const id = String(body.id || "");
    const { data: existing } = await admin.from("employees").select("*")
      .eq("id", id).eq("organization_id", currentEmployee.organization_id).maybeSingle();
    if (!existing) return json({ error: "Fant ikke den ansatte." }, 404);
    const { data: existingDetails } = await admin.from("employee_private_details").select("*").eq("employee_id", id).maybeSingle();
    let details; try { details = privateDetails(body, existingDetails || {}); } catch (error) { return json({ error: (error as Error).message }, 400); }
    if (existing.auth_user_id === currentUser.id && body.active === false) {
      return json({ error: "Du kan ikke deaktivere din egen administratorbruker." }, 400);
    }
    const role = body.role ?? existing.role;
    if (!validRole(role)) return json({ error: "Ugyldig rolle." }, 400);
    const email = String(body.email ?? existing.email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Ugyldig e-postadresse." }, 400);
    const active = body.active === undefined ? existing.active : Boolean(body.active);
    const patch = {
      employee_number: String(body.employee_number ?? existing.employee_number).trim(),
      full_name: String(body.full_name ?? existing.full_name).trim(),
      email,
      phone_number: String(body.phone_number ?? existing.phone_number ?? "").trim() || null,
      role,
      active,
      deactivated_at: active ? null : new Date().toISOString(),
      deactivated_by: active ? null : currentUser.id,
      updated_at: new Date().toISOString(),
    };
    if (!patch.employee_number || !patch.full_name) return json({ error: "Ansattnummer og navn må fylles ut." }, 400);
    const { data: employee, error } = await admin.from("employees").update(patch)
      .eq("id", id).eq("organization_id", currentEmployee.organization_id).select().single();
    if (error) return json({ error: error.message }, 400);
    const detailResult = await admin.from("employee_private_details").upsert({ employee_id: id, organization_id: currentEmployee.organization_id, ...details, updated_by: currentUser.id, updated_at: new Date().toISOString() }, { onConflict: "employee_id" });
    if (detailResult.error) return json({ error: detailResult.error.message }, 400);
    if (existing.auth_user_id) {
      const { error: authUpdateError } = await admin.auth.admin.updateUserById(existing.auth_user_id, {
        email,
        email_confirm: true,
        app_metadata: { role },
        user_metadata: { full_name: patch.full_name },
        ban_duration: active ? "none" : "876000h",
      });
      if (authUpdateError) return json({ error: "Ansattdata ble lagret, men innloggingen kunne ikke oppdateres.", detail: authUpdateError.message }, 500);
    }
    await admin.from("audit_logs").insert({
      organization_id: currentEmployee.organization_id,
      actor_id: currentUser.id,
      action: active ? "update_employee" : "deactivate_employee",
      entity_type: "employee",
      entity_id: id,
      details: { before: { employee_number: existing.employee_number, email: existing.email, role: existing.role, active: existing.active }, after: patch, private_fields_updated: Object.keys(details) },
    });
    return json({ employee: { ...employee, ...details } });
  }

  return json({ error: "Handling støttes ikke." }, 405);
});
