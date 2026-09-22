import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const types=["self_certification","medical_certificate","sick_child"];
const routineVersion="2026-09-21";
const dateOk=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
const todayOslo=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date());
const weekdays=(from:string,to:string)=>{let count=0;for(let d=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`);d<=end;d.setUTCDate(d.getUTCDate()+1)){const day=d.getUTCDay();if(day!==0&&day!==6)count++}return count};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,employee_number,email").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);

  if(req.method==="GET"){
    const url=new URL(req.url),from=url.searchParams.get("from"),to=url.searchParams.get("to");
    let query=admin.from("sick_leave_requests").select("id,employee_id,absence_type,start_date,end_date,status,routine_acknowledged_at,employee_note,admin_comment,handled_at,created_at,employees(employee_number,full_name,email)").eq("organization_id",me.organization_id).order("created_at",{ascending:false});
    if(me.role!=="admin")query=query.eq("employee_id",me.id);else if(from&&to)query=query.lte("start_date",to).gte("end_date",from);
    const {data:requests,error}=await query;if(error)return json({error:error.message},400);
    if(me.role!=="admin")return json({requests:requests||[],routine_version:routineVersion});
    const rangeFrom=from&&dateOk(from)?from:`${todayOslo().slice(0,4)}-01-01`,rangeTo=to&&dateOk(to)?to:todayOslo();
    const [{data:adjustments,error:adjustError},{data:staff,error:staffError}]=await Promise.all([
      admin.from("payroll_adjustments").select("employee_id,work_date,hours,sick_leave_request_id").eq("organization_id",me.organization_id).not("sick_leave_request_id","is",null).gte("work_date",rangeFrom).lte("work_date",rangeTo),
      admin.from("employees").select("id,employee_number,full_name,created_at,deactivated_at").eq("organization_id",me.organization_id).lte("created_at",`${rangeTo}T23:59:59Z`).or(`deactivated_at.is.null,deactivated_at.gte.${rangeFrom}T00:00:00Z`)
    ]);if(adjustError||staffError)return json({error:adjustError?.message||staffError?.message},400);
    const expected=weekdays(rangeFrom,rangeTo)*8*(staff?.length||0),sickHours=(adjustments||[]).reduce((s,a)=>s+Number(a.hours),0);
    const byEmployee=(staff||[]).map(e=>({employee_id:e.id,employee_number:e.employee_number,full_name:e.full_name,hours:(adjustments||[]).filter(a=>a.employee_id===e.id).reduce((s,a)=>s+Number(a.hours),0),days:(adjustments||[]).filter(a=>a.employee_id===e.id).length})).filter(e=>e.hours>0);
    return json({requests:requests||[],routine_version:routineVersion,statistics:{from:rangeFrom,to:rangeTo,sick_hours:sickHours,expected_hours:expected,absence_percentage:expected?100*sickHours/expected:0,employees:byEmployee}});
  }

  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  const action=String(body.action||"");
  if(req.method==="POST"&&action==="submit"){
    const absenceType=String(body.absence_type||""),start=String(body.start_date||""),end=String(body.end_date||start),note=String(body.employee_note||"").trim();
    if(!types.includes(absenceType)||!dateOk(start)||!dateOk(end)||body.routine_acknowledged!==true)return json({error:"Velg fraværstype og dato, og bekreft at rutinen er lest."},400);
    const today=todayOslo();if(start>today||end>today)return json({error:"Sykefravær kan ikke registreres frem i tid."},400);if(end<start)return json({error:"Til-dato kan ikke være før fra-dato."},400);if(absenceType!=="medical_certificate"&&start!==end)return json({error:"Egenmelding og sykt barn registreres for én dag om gangen."},400);
    const result=await admin.from("sick_leave_requests").insert({organization_id:me.organization_id,employee_id:me.id,absence_type:absenceType,start_date:start,end_date:end,routine_version:routineVersion,routine_acknowledged_at:new Date().toISOString(),employee_note:note||null}).select("id,status,created_at").single();
    if(result.error){if(result.error.code==="23505")return json({error:"Dette sykefraværet er allerede sendt inn."},409);return json({error:result.error.message},400)}
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"submit_sick_leave",entity_type:"sick_leave_request",entity_id:result.data.id,details:{absence_type:absenceType,start_date:start,end_date:end,routine_version:routineVersion}});
    let emailSent=false;const resendKey=Deno.env.get("RESEND_API_KEY");if(resendKey){const labels:{[key:string]:string}={self_certification:"Egenmelding",medical_certificate:"Sykmelding fra lege",sick_child:"Sykt barn"};try{const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Apart Tid <post@apartstavanger.no>",to:["post@apartstavanger.no"],subject:`Nytt sykefravær fra ${me.full_name}`,html:`<h2>Nytt sykefravær i Apart Tid</h2><p><strong>${me.employee_number} · ${me.full_name}</strong></p><p>Type: ${labels[absenceType]}<br>Periode: ${start}${end!==start?`–${end}`:""}</p><p>Logg inn i Apart Tid for å behandle meldingen.</p>`})});emailSent=response.ok}catch{/* Request remains saved even if notification fails. */}}
    return json({request:result.data,email_sent:emailSent},201);
  }
  if(req.method==="PATCH"&&action==="handle"){
    if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);const id=String(body.id||""),status=String(body.status||""),comment=String(body.admin_comment||"").trim();if(!id||!["approved","rejected"].includes(status))return json({error:"Velg godkjenn eller avvis."},400);if(status==="rejected"&&comment.length<3)return json({error:"Skriv en kort kommentar ved avvisning."},400);
    const {data,error}=await admin.rpc("process_sick_leave_request",{p_request_id:id,p_status:status,p_admin_comment:comment,p_handled_by:authData.user.id});if(error)return json({error:error.message},400);return json({result:data});
  }
  return json({error:"Handling støttes ikke."},405);
});
