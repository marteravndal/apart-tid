import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, DELETE, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
const timeOk=(v:string)=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const addDays=(value:string,days:number)=>{const d=new Date(`${value}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
const monday=(value:string)=>{const d=new Date(`${value}T12:00:00Z`),day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()-day+1);return d.toISOString().slice(0,10)};
const todayOslo=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date());
const minutes=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3,5));
const interval=(date:string,start:string,end:string)=>{const base=new Date(`${date}T00:00:00Z`).getTime(),a=base+minutes(start)*60000,b=base+minutes(end)*60000;return[a,b<=a?b+86400000:b]};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const appUrl=()=>Deno.env.get("APP_URL")||"https://tid.apartstavanger.no";
const sendEmail=async(to:string,subject:string,html:string)=>{const key=Deno.env.get("RESEND_API_KEY");if(!key)return false;try{return(await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Apart Tid <post@apartstavanger.no>",to:[to],subject,html})})).ok}catch{return false}};
const cleanTime=(value:unknown)=>String(value||"").slice(0,5);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,email").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);
  const url=new URL(req.url),week=monday(String(url.searchParams.get("week")||todayOslo()));
  if(!dateOk(week))return json({error:"Ugyldig uke."},400);

  if(req.method==="GET"){
    const {data:schedule,error:scheduleError}=await admin.from("shift_schedules").select("id,week_start,status,published_snapshot,published_at,updated_at").eq("organization_id",me.organization_id).eq("week_start",week).maybeSingle();if(scheduleError)return json({error:scheduleError.message},400);
    if(me.role!=="admin")return json({week_start:week,status:schedule?.status||"draft",shifts:schedule?.status==="published"?(schedule.published_snapshot||[]).filter((x:any)=>x.employee_id===me.id):[]});
    const [{data:settings,error:settingsError},{data:staff,error:staffError},{data:shifts,error:shiftError},{data:absences,error:absenceError}]=await Promise.all([
      admin.from("shift_settings").select("day_start,day_end,evening_start,evening_end,night_start,night_end").eq("organization_id",me.organization_id).maybeSingle(),
      admin.from("employees").select("id,employee_number,full_name,email").eq("organization_id",me.organization_id).eq("active",true).order("full_name"),
      schedule?admin.from("scheduled_shifts").select("id,employee_id,work_date,shift_type,start_time,end_time").eq("schedule_id",schedule.id).order("work_date").order("start_time"):Promise.resolve({data:[],error:null}),
      admin.from("vacation_requests").select("id,employee_id,request_type,start_date,end_date").eq("organization_id",me.organization_id).eq("status","approved").lte("start_date",addDays(week,6)).gte("end_date",week)
    ]);if(settingsError||staffError||shiftError||absenceError)return json({error:settingsError?.message||staffError?.message||shiftError?.message||absenceError?.message},400);
    return json({week_start:week,schedule,settings:settings||{day_start:"08:00:00",day_end:"16:00:00",evening_start:"16:00:00",evening_end:"23:00:00",night_start:"23:00:00",night_end:"07:00:00"},employees:staff||[],shifts:shifts||[],absences:absences||[]});
  }

  if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  let body:Record<string,any>={};try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="PATCH"&&action==="settings"){
    const values=["day_start","day_end","evening_start","evening_end","night_start","night_end"].reduce((o,k)=>({...o,[k]:cleanTime(body[k])}),{} as Record<string,string>);if(Object.values(values).some(v=>!timeOk(v)))return json({error:"Alle skifttider må være gyldige."},400);
    const {error}=await admin.from("shift_settings").upsert({organization_id:me.organization_id,...values,updated_by:authData.user.id,updated_at:new Date().toISOString()},{onConflict:"organization_id"});if(error)return json({error:error.message},400);return json({ok:true});
  }
  const getSchedule=async(create=true)=>{const {data:existing,error}=await admin.from("shift_schedules").select("*").eq("organization_id",me.organization_id).eq("week_start",week).maybeSingle();if(error)throw error;if(existing||!create)return existing;const {data,error:insertError}=await admin.from("shift_schedules").insert({organization_id:me.organization_id,week_start:week,created_by:authData.user.id}).select("*").single();if(insertError)throw insertError;return data};
  if(req.method==="POST"&&action==="save_shift"){
    const employeeId=String(body.employee_id||""),workDate=String(body.work_date||""),type=String(body.shift_type||""),start=cleanTime(body.start_time),end=cleanTime(body.end_time),id=String(body.id||"");if(!employeeId||!dateOk(workDate)||workDate<week||workDate>addDays(week,6)||!["day","evening","night"].includes(type)||!timeOk(start)||!timeOk(end)||start===end)return json({error:"Fyll ut ansatt, dag, skift og gyldige klokkeslett."},400);
    const {data:employee}=await admin.from("employees").select("id").eq("id",employeeId).eq("organization_id",me.organization_id).eq("active",true).maybeSingle();if(!employee)return json({error:"Den ansatte er ikke aktiv."},400);const schedule=await getSchedule();
    const {data:rows}=await admin.from("scheduled_shifts").select("id,work_date,start_time,end_time").eq("schedule_id",schedule.id).eq("employee_id",employeeId);const [from,to]=interval(workDate,start,end),overlap=(rows||[]).some((x:any)=>{if(x.id===id)return false;const[a,b]=interval(x.work_date,cleanTime(x.start_time),cleanTime(x.end_time));return from<b&&to>a});if(overlap)return json({error:"Vakten overlapper en annen vakt for den ansatte."},409);
    const payload={schedule_id:schedule.id,organization_id:me.organization_id,employee_id:employeeId,work_date:workDate,shift_type:type,start_time:start,end_time:end,created_by:authData.user.id,updated_at:new Date().toISOString()};const result=id?await admin.from("scheduled_shifts").update(payload).eq("id",id).eq("schedule_id",schedule.id).select("id").maybeSingle():await admin.from("scheduled_shifts").insert(payload).select("id").single();if(result.error||!result.data)return json({error:result.error?.message||"Vakten finnes ikke."},400);await admin.from("shift_schedules").update({updated_at:new Date().toISOString()}).eq("id",schedule.id);return json({id:result.data.id},id?200:201);
  }
  if(req.method==="DELETE"&&action==="delete_shift"){
    const schedule=await getSchedule(false);if(!schedule)return json({ok:true});const {error}=await admin.from("scheduled_shifts").delete().eq("id",String(body.id||"")).eq("schedule_id",schedule.id);if(error)return json({error:error.message},400);await admin.from("shift_schedules").update({updated_at:new Date().toISOString()}).eq("id",schedule.id);return json({ok:true});
  }
  if(req.method==="POST"&&action==="copy_previous"){
    const previous=addDays(week,-7),{data:source}=await admin.from("shift_schedules").select("id").eq("organization_id",me.organization_id).eq("week_start",previous).maybeSingle();if(!source)return json({error:"Forrige uke har ingen vaktliste å kopiere."},404);const {data:sourceShifts}=await admin.from("scheduled_shifts").select("employee_id,work_date,shift_type,start_time,end_time").eq("schedule_id",source.id);if(!sourceShifts?.length)return json({error:"Forrige uke har ingen vakter å kopiere."},404);const target=await getSchedule();const {count}=await admin.from("scheduled_shifts").select("id",{count:"exact",head:true}).eq("schedule_id",target.id);if(count)return json({error:"Uken inneholder allerede vakter. Fjern dem før du kopierer."},409);const rows=sourceShifts.map((x:any)=>({...x,work_date:addDays(x.work_date,7),schedule_id:target.id,organization_id:me.organization_id,created_by:authData.user.id,updated_at:new Date().toISOString()}));const {error}=await admin.from("scheduled_shifts").insert(rows);if(error)return json({error:error.message},400);return json({copied:rows.length});
  }
  if(req.method==="PATCH"&&action==="publish"){
    const schedule=await getSchedule(false);if(!schedule)return json({error:"Legg til minst én vakt før publisering."},409);const {data:shifts}=await admin.from("scheduled_shifts").select("id,employee_id,work_date,shift_type,start_time,end_time,employees(full_name,email)").eq("schedule_id",schedule.id).order("work_date").order("start_time");if(!shifts?.length)return json({error:"Legg til minst én vakt før publisering."},409);const snapshot=shifts.map((x:any)=>({id:x.id,employee_id:x.employee_id,employee_name:x.employees.full_name,work_date:x.work_date,shift_type:x.shift_type,start_time:cleanTime(x.start_time),end_time:cleanTime(x.end_time)})),now=new Date().toISOString();const {error}=await admin.from("shift_schedules").update({status:"published",published_snapshot:snapshot,published_at:now,published_by:authData.user.id,updated_at:now}).eq("id",schedule.id);if(error)return json({error:error.message},400);const recipients=[...new Map(shifts.map((x:any)=>[x.employee_id,x.employees])).values()] as any[];const notices=await Promise.all(recipients.map((e:any)=>sendEmail(e.email,"Ny vaktliste i Apart Tid",`<h2>Vaktlisten er publisert</h2><p>Hei ${esc(e.full_name)}.</p><p>Vaktlisten for uken som starter ${week} er klar.</p><p><a href="${appUrl()}">Logg inn og åpne Vaktliste</a>.</p>`)));return json({published:shifts.length,recipients:recipients.length,email_sent:notices.filter(Boolean).length});
  }
  if(req.method==="PATCH"&&action==="inactive"){
    const schedule=await getSchedule(false);if(!schedule)return json({error:"Vaktlisten finnes ikke."},404);const {error}=await admin.from("shift_schedules").update({status:"inactive",updated_at:new Date().toISOString()}).eq("id",schedule.id);if(error)return json({error:error.message},400);return json({ok:true});
  }
  return json({error:"Handling støttes ikke."},405);
});
