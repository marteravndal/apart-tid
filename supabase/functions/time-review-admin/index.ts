import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { premiumHoursBetween } from "../_shared/payroll-premiums.ts";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const monthPattern=/^\d{4}-(0[1-9]|1[0-2])$/;
const osloDate=(value:string)=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date(value));
const osloMonth=(value:string)=>osloDate(value).slice(0,7);
const addDays=(value:string,days:number)=>{const d=new Date(`${value}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
const cleanTime=(value:unknown)=>String(value||"").slice(0,5);
const osloWallMs=(date:string,time:string)=>{const[y,m,d]=date.split("-").map(Number),[hour,minute]=cleanTime(time).split(":").map(Number),wanted=Date.UTC(y,m-1,d,hour,minute);let guess=wanted;for(let i=0;i<3;i++){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Oslo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess)).reduce((o:any,x)=>(o[x.type]=Number(x.value)||x.value,o),{});guess+=wanted-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)}return guess};
const rosterAnnotation=(entry:any,schedules:any[],employeeId:string)=>{if(entry.kind!=="work")return null;const shifts=schedules.flatMap((schedule:any)=>(Array.isArray(schedule.published_snapshot)?schedule.published_snapshot:[])).filter((shift:any)=>shift.employee_id===employeeId).map((shift:any)=>{const startTime=cleanTime(shift.start_time),endTime=cleanTime(shift.end_time),start=osloWallMs(shift.work_date,startTime),end=osloWallMs(endTime<=startTime?addDays(shift.work_date,1):shift.work_date,endTime);return{...shift,start_time:startTime,end_time:endTime,start_ms:start,end_ms:end}});const started=new Date(entry.started_at).getTime(),candidate=shifts.filter((shift:any)=>Math.abs(shift.start_ms-started)<=12*3600000).sort((a:any,b:any)=>Math.abs(a.start_ms-started)-Math.abs(b.start_ms-started))[0];if(!candidate){const date=osloDate(entry.started_at),previous=addDays(date,-1),covered=schedules.some((schedule:any)=>{const end=addDays(schedule.week_start,6);return(date>=schedule.week_start&&date<=end)||(previous>=schedule.week_start&&previous<=end)});return covered?{status:"unplanned"}:null}const startDelta=Math.round((started-candidate.start_ms)/60000),endDelta=entry.ended_at?Math.round((new Date(entry.ended_at).getTime()-candidate.end_ms)/60000):null;return{status:Math.abs(startDelta)>=1||(endDelta!==null&&Math.abs(endDelta)>=1)?"deviation":"match",planned:{work_date:candidate.work_date,start_time:candidate.start_time,end_time:candidate.end_time},start_delta_minutes:startDelta,end_delta_minutes:endDelta}};
const range=(monthStart:string)=>{const from=new Date(`${monthStart}T00:00:00Z`);from.setUTCDate(from.getUTCDate()-1);const to=new Date(`${monthStart}T00:00:00Z`);to.setUTCMonth(to.getUTCMonth()+1);to.setUTCDate(to.getUTCDate()+1);return{from:from.toISOString(),to:to.toISOString()}};
const entryHours=(entry:{started_at:string;ended_at:string|null})=>entry.ended_at?Math.max(0,(new Date(entry.ended_at).getTime()-new Date(entry.started_at).getTime())/3600000):0;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active||me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  if(body.action==="stamp_shift"){
    const shiftId=String(body.shift_id||""),reason=String(body.reason||"").trim(),kind=String(body.kind||"");
    if(!/^[0-9a-f-]{36}$/i.test(shiftId)||!["work","sick_pay"].includes(kind)||reason.length<3||reason.length>1000||!Number.isFinite(Date.parse(String(body.started_at)))||!Number.isFinite(Date.parse(String(body.ended_at)))||!body.expected)return json({error:"Kontroller vakten, tidene, lønnsarten og begrunnelsen."},400);
    const {data,error}=await admin.rpc("stamp_roster_shift",{p_organization_id:me.organization_id,p_actor_id:authData.user.id,p_shift_id:shiftId,p_expected:body.expected,p_started_at:body.started_at,p_ended_at:body.ended_at,p_kind:kind,p_reason:reason});
    if(error)return json({error:error.message},409);return json(data,201);
  }
  if(body.action==="roster_attendance"){
    const ids=body.shift_ids;if(!Array.isArray(ids)||ids.length>250||ids.some(x=>typeof x!=="string"||!/^[0-9a-f-]{36}$/i.test(x)))return json({error:"Ugyldig vaktliste."},400);
    if(!ids.length)return json({entries:[]});
    const {data,error}=await admin.from("time_entries").select("id,reference_no,scheduled_shift_id,kind,started_at,ended_at").eq("organization_id",me.organization_id).in("scheduled_shift_id",ids);
    if(error)return json({error:"Kunne ikke kontrollere etterregistrerte vakter."},503);return json({entries:data||[]});
  }
  if(body.action==="delete"){
    const entryId=String(body.entry_id||""),reason=String(body.reason||"").trim();
    if(!/^[0-9a-f-]{36}$/i.test(entryId)||reason.length<3||reason.length>1000||!Number.isFinite(Date.parse(String(body.started_at)))||!Number.isFinite(Date.parse(String(body.ended_at))))return json({error:"Velg en avsluttet registrering og skriv en begrunnelse på 3–1000 tegn."},400);
    const {data,error}=await admin.rpc("delete_clock_entry",{p_organization_id:me.organization_id,p_actor_id:authData.user.id,p_entry_id:entryId,p_started_at:body.started_at,p_ended_at:body.ended_at,p_reason:reason});
    if(error)return json({error:error.message},409);
    return json(data);
  }
  const action=String(body.action||"load"),month=String(body.month||"");if(!monthPattern.test(month))return json({error:"Velg en gyldig måned."},400);
  const monthStart=`${month}-01`,bounds=range(monthStart),nextMonthStart=new Date(`${monthStart}T00:00:00Z`);nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth()+1);const nextMonth=nextMonthStart.toISOString().slice(0,10);
  const {data:monthLock}=await admin.from("month_locks").select("id,locked_at,revision").eq("organization_id",me.organization_id).eq("month_start",monthStart).is("superseded_at",null).maybeSingle();
  if(action==="register"){
    const employeeId=String(body.employee_id||""),status=String(body.status||"all"),reference=String(body.reference||"").trim().toUpperCase(),page=Number(body.page||0);
    if(!["all","active","open","deleted"].includes(status)||!Number.isInteger(page)||page<0||page>10000||employeeId&&!/^[0-9a-f-]{36}$/i.test(employeeId)||reference&&!/^(ST-)?[0-9]{1,15}$/.test(reference))return json({error:"Kontroller filtrene. Referansen skal være for eksempel ST-000123."},400);
    const {data:people,error:peopleError}=await admin.from("employees").select("id,full_name,employee_number,auth_user_id").eq("organization_id",me.organization_id).order("full_name");
    if(peopleError)return json({error:"Ansattlisten kunne ikke hentes."},503);
    if(employeeId&&!(people||[]).some(x=>x.id===employeeId))return json({error:"Ansatt ble ikke funnet."},404);
    // An exact reference lookup spans all months, while retaining employee/status filters.
    let query=admin.from("clock_register").select("*").eq("organization_id",me.organization_id);
    if(reference)query=query.eq("reference_no",Number(reference.replace(/^ST-/,"")));
    else query=query.gte("started_at",new Date(osloWallMs(monthStart,"00:00")).toISOString()).lt("started_at",new Date(osloWallMs(nextMonth,"00:00")).toISOString());
    if(employeeId)query=query.eq("employee_id",employeeId);
    if(status==="deleted")query=query.not("deleted_at","is",null);
    if(status==="active"||status==="open")query=query.is("deleted_at",null);
    if(status==="open")query=query.is("ended_at",null);
    const {data:rows,error}=await query.order("started_at",{ascending:false}).order("id").range(page*50,page*50+50);
    if(error)return json({error:"Stemplingene kunne ikke hentes."},503);
    const entries=(rows||[]).slice(0,50),ids=entries.map(x=>x.id);
    const [{data:events,error:eventsError},{data:locks,error:locksError},{data:approvals,error:approvalsError}]=await Promise.all([
      ids.length?admin.from("audit_logs").select("id,actor_id,action,created_at,entity_id,details").eq("organization_id",me.organization_id).eq("entity_type","time_entry").in("entity_id",ids).order("created_at",{ascending:false}).limit(1001):Promise.resolve({data:[],error:null}),
      admin.from("month_locks").select("month_start").eq("organization_id",me.organization_id).is("superseded_at",null),
      admin.from("month_approvals").select("employee_id,month_start").eq("organization_id",me.organization_id).eq("status","locked")
    ]);
    if(eventsError||locksError||approvalsError)return json({error:"Historikken eller månedsstatusen kunne ikke hentes."},503);
    const names=new Map((people||[]).map(x=>[x.auth_user_id,x.full_name])),peopleById=new Map((people||[]).map(x=>[x.id,x]));
    return json({entries:entries.map(x=>({...x,employee_name:peopleById.get(x.employee_id)?.full_name||"Tidligere ansatt",employee_number:peopleById.get(x.employee_id)?.employee_number||"",deleted_by_name:x.deleted_by?names.get(x.deleted_by)||"Tidligere ADMIN":null,locked:(locks||[]).some(l=>String(l.month_start).slice(0,7)===osloMonth(x.started_at))||(approvals||[]).some(a=>a.employee_id===x.employee_id&&String(a.month_start).slice(0,7)===osloMonth(x.started_at))})),employees:(people||[]).map(({auth_user_id,...x})=>x),page,has_more:(rows||[]).length>50,events_truncated:(events||[]).length>1000,events:(events||[]).slice(0,1000).map(x=>({entry_id:x.entity_id,at:x.created_at,action:x.action,actor:names.get(x.actor_id)||"System / tidligere bruker",reason:x.details?.reason||null,before:x.details?.before?{started_at:x.details.before.started_at,ended_at:x.details.before.ended_at}:null,after:x.details?.after?{started_at:x.details.after.started_at,ended_at:x.details.after.ended_at}:null}))});
  }
  const loadMonth=async()=>{const [{data:employees,error:employeesError},{data:rawEntries,error:entriesError},{data:adjustments,error:adjustmentsError},{data:approvals,error:approvalsError}]=await Promise.all([
    admin.from("employees").select("id,employee_number,full_name,active").eq("organization_id",me.organization_id).order("full_name"),
    admin.from("time_entries").select("id,reference_no,employee_id,kind,started_at,ended_at,source,auto_clocked_out,note,updated_at").eq("organization_id",me.organization_id).gte("started_at",bounds.from).lt("started_at",bounds.to).order("started_at"),
    admin.from("payroll_adjustments").select("employee_id,work_date,category,hours").eq("organization_id",me.organization_id).gte("work_date",monthStart).lt("work_date",nextMonth),
    admin.from("month_approvals").select("employee_id,status,approved_at").eq("organization_id",me.organization_id).eq("month_start",monthStart),
  ]);const error=employeesError||entriesError||adjustmentsError||approvalsError;if(error)throw new Error(error.message);return{employees:employees||[],entries:(rawEntries||[]).filter(e=>osloMonth(e.started_at)===month),adjustments:adjustments||[],approvals:approvals||[]}};
  if(action==="overview"||action==="lock_month"){
    let data;try{data=await loadMonth()}catch(error){return json({error:error instanceof Error?error.message:"Kunne ikke hente måneden."},400)}
    const relevantIds=new Set([...data.entries.map(e=>e.employee_id),...data.adjustments.map(a=>a.employee_id)]),approvalMap=new Map(data.approvals.map(a=>[a.employee_id,a]));
    const rows=data.employees.filter(e=>relevantIds.has(e.id)).map(e=>{const entries=data.entries.filter(x=>x.employee_id===e.id),approval=approvalMap.get(e.id);return{...e,status:monthLock?"locked":approval?.status||"open",approved_at:approval?.approved_at||null,entries:entries.length,hours:entries.reduce((sum,x)=>sum+entryHours(x),0),open_entries:entries.filter(x=>!x.ended_at).length}});
    if(action==="overview")return json({month,status:monthLock?"locked":"open",locked_at:monthLock?.locked_at||null,revision:monthLock?.revision||null,employees:rows});
    if(monthLock)return json({error:"Måneden er allerede låst."},409);if(!rows.length)return json({error:"Måneden har ingen registreringer."},409);if(rows.some(r=>r.open_entries>0))return json({error:"Alle åpne registreringer må stemples ut før måneden låses."},409);if(rows.some(r=>r.status!=="approved"))return json({error:"Alle ansatte med registreringer må være godkjent før måneden låses."},409);
    const {data:settings,error:settingsError}=await admin.from("payroll_settings").select("category,payroll_code,label,hourly_rate").eq("organization_id",me.organization_id);if(settingsError)return json({error:settingsError.message},400);const payrollCodes=Object.fromEntries((settings||[]).map(s=>[s.category,{code:s.payroll_code,label:s.label,hourly_rate:s.hourly_rate}]));
    const {data:lock,error:lockError}=await admin.from("month_locks").insert({organization_id:me.organization_id,month_start:monthStart,revision:1,locked_by:authData.user.id}).select("id,locked_at,revision").single();if(lockError)return json({error:lockError.message},409);
    let verified;try{verified=await loadMonth()}catch{await admin.from("month_locks").delete().eq("id",lock.id);return json({error:"Kunne ikke kontrollere måneden. Prøv igjen."},503)}
    const fingerprint=(items:any[])=>JSON.stringify(items.map(x=>[x.id,x.started_at,x.ended_at,x.updated_at]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    if(fingerprint(data.entries)!==fingerprint(verified.entries)||rows.some(row=>!verified.approvals.some(x=>x.employee_id===row.id&&x.status==="approved"))){await admin.from("month_locks").delete().eq("id",lock.id);return json({error:"Timene er endret under låsing. Kontroller og godkjenn måneden på nytt."},409)}
    const snapshots=rows.map(employee=>{const entries=data.entries.filter(e=>e.employee_id===employee.id),workEntries=entries.filter(e=>e.kind==="work"),premiums=workEntries.reduce((sum,e)=>{const value=premiumHoursBetween(e.started_at,e.ended_at);return{evening:sum.evening+value.evening,night:sum.night+value.night,weekend:sum.weekend+value.weekend}},{evening:0,night:0,weekend:0});const adjustments=data.adjustments.filter(a=>a.employee_id===employee.id);return{lock_id:lock.id,employee_id:employee.id,employee_number:employee.employee_number,employee_name:employee.full_name,ordinary_hours:workEntries.reduce((s,e)=>s+entryHours(e),0),evening_hours:premiums.evening,night_hours:premiums.night,weekend_hours:premiums.weekend,sick_pay_hours:entries.filter(e=>e.kind==="sick_pay").reduce((s,e)=>s+entryHours(e),0),overtime_40_hours:adjustments.filter(a=>a.category==="overtime_40").reduce((s,a)=>s+Number(a.hours),0),overtime_100_hours:adjustments.filter(a=>a.category==="overtime_100").reduce((s,a)=>s+Number(a.hours),0),payroll_codes:payrollCodes}});
    const inserted=await admin.from("month_snapshot_rows").insert(snapshots);if(inserted.error){await admin.from("month_locks").delete().eq("id",lock.id);return json({error:inserted.error.message},400)}
    const locked=await admin.from("month_approvals").update({status:"locked"}).eq("organization_id",me.organization_id).eq("month_start",monthStart).in("employee_id",rows.map(r=>r.id));if(locked.error){await admin.from("month_snapshot_rows").delete().eq("lock_id",lock.id);await admin.from("month_locks").delete().eq("id",lock.id);return json({error:locked.error.message},400)}
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"lock_month",entity_type:"month_lock",entity_id:lock.id,details:{month_start:monthStart,revision:lock.revision,employees:rows.length}});return json({ok:true,lock,employees:rows.length});
  }
  const employeeId=String(body.employee_id||"");if(!employeeId)return json({error:"Velg en ansatt."},400);const {data:employee}=await admin.from("employees").select("id,employee_number,full_name").eq("id",employeeId).eq("organization_id",me.organization_id).maybeSingle();if(!employee)return json({error:"Ansatt ble ikke funnet."},404);
  if(action==="correct"){
    if(monthLock)return json({error:"Måneden er låst og kan ikke endres."},409);const entryId=String(body.entry_id||""),reason=String(body.reason||"").trim(),startedAt=String(body.started_at||""),endedAt=String(body.ended_at||"");if(reason.length<3)return json({error:"Skriv en begrunnelse på minst tre tegn."},400);
    const start=new Date(startedAt),end=new Date(endedAt);if(!entryId||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return json({error:"Kontroller inn- og uttid."},400);if(osloMonth(startedAt)!==month||osloMonth(endedAt)!==month)return json({error:"Tidene må være innenfor valgt måned."},400);
    const {data:before}=await admin.from("time_entries").select("id,employee_id,started_at,ended_at,source,note").eq("id",entryId).eq("employee_id",employeeId).eq("organization_id",me.organization_id).maybeSingle();if(!before)return json({error:"Registreringen ble ikke funnet."},404);
    const note=[before.note,`Korrigert av admin: ${reason}`].filter(Boolean).join("\n"),{data:entry,error}=await admin.from("time_entries").update({started_at:start.toISOString(),ended_at:end.toISOString(),source:"manual",note,updated_at:new Date().toISOString()}).eq("id",entryId).select("id,started_at,ended_at,source,auto_clocked_out,note,kind").single();if(error)return json({error:error.message},400);
    await admin.from("month_approvals").update({status:"open",approved_by:null,approved_at:null}).eq("organization_id",me.organization_id).eq("employee_id",employeeId).eq("month_start",monthStart);await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"correct_time_entry",entity_type:"time_entry",entity_id:entryId,details:{employee_id:employeeId,reason,before:{started_at:before.started_at,ended_at:before.ended_at,source:before.source},after:{started_at:entry.started_at,ended_at:entry.ended_at,source:entry.source}}});return json({entry});
  }
  if(action==="approve"){
    if(monthLock)return json({error:"Måneden er allerede låst."},409);const {data:entries}=await admin.from("time_entries").select("id,started_at,ended_at").eq("employee_id",employeeId).gte("started_at",bounds.from).lt("started_at",bounds.to);const relevant=(entries||[]).filter(e=>osloMonth(e.started_at)===month);if(relevant.some(e=>!e.ended_at))return json({error:"Måneden har åpne registreringer og kan ikke godkjennes."},409);
    const now=new Date().toISOString(),{data:existing}=await admin.from("month_approvals").select("employee_id,status").eq("organization_id",me.organization_id).eq("employee_id",employeeId).eq("month_start",monthStart).maybeSingle(),values={status:"approved",approved_by:authData.user.id,approved_at:now};const result=existing?await admin.from("month_approvals").update(values).eq("organization_id",me.organization_id).eq("employee_id",employeeId).eq("month_start",monthStart):await admin.from("month_approvals").insert({organization_id:me.organization_id,employee_id:employeeId,month_start:monthStart,...values});if(result.error)return json({error:result.error.message},400);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"approve_employee_month",entity_type:"employee",entity_id:employeeId,details:{month_start:monthStart}});return json({ok:true});
  }
  if(action!=="load")return json({error:"Ukjent handling."},400);const [{data:allEntries,error:entriesError},{data:approval,error:approvalError},{data:schedules,error:schedulesError}]=await Promise.all([admin.from("time_entries").select("id,reference_no,kind,started_at,ended_at,source,auto_clocked_out,note").eq("employee_id",employeeId).gte("started_at",bounds.from).lt("started_at",bounds.to).order("started_at"),admin.from("month_approvals").select("status,approved_at").eq("organization_id",me.organization_id).eq("employee_id",employeeId).eq("month_start",monthStart).maybeSingle(),admin.from("shift_schedules").select("week_start,published_snapshot").eq("organization_id",me.organization_id).eq("status","published").gte("week_start",addDays(monthStart,-6)).lt("week_start",nextMonth)]);if(entriesError||approvalError||schedulesError)return json({error:entriesError?.message||approvalError?.message||schedulesError?.message},400);
  const entries=(allEntries||[]).filter(e=>osloMonth(e.started_at)===month).map((entry:any)=>({...entry,roster_match:rosterAnnotation(entry,schedules||[],employeeId)}));
  return json({employee,month,entries,status:monthLock?"locked":approval?.status||"open",approved_at:approval?.approved_at||null,locked_at:monthLock?.locked_at||null});
});

