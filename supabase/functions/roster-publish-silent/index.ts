import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const monday=(value:string)=>{const date=new Date(`${value}T12:00:00Z`),day=date.getUTCDay()||7;date.setUTCDate(date.getUTCDate()-day+1);return date.toISOString().slice(0,10)};
const cleanTime=(value:unknown)=>String(value||"").slice(0,5);

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active||me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  const requestedWeek=String(body.week||"");if(!dateOk(requestedWeek))return json({error:"Velg en gyldig uke."},400);const week=monday(requestedWeek);
  const {data:schedule,error:scheduleError}=await admin.from("shift_schedules").select("id").eq("organization_id",me.organization_id).eq("week_start",week).maybeSingle();if(scheduleError)return json({error:scheduleError.message},400);if(!schedule)return json({error:"Legg til minst én vakt før publisering."},409);
  const {data:shifts,error:shiftsError}=await admin.from("scheduled_shifts").select("id,employee_id,work_date,shift_type,start_time,end_time,employees(full_name)").eq("schedule_id",schedule.id).order("work_date").order("start_time");if(shiftsError)return json({error:shiftsError.message},400);if(!shifts?.length)return json({error:"Legg til minst én vakt før publisering."},409);
  const snapshot=shifts.map((shift:any)=>({id:shift.id,employee_id:shift.employee_id,employee_name:shift.employees.full_name,work_date:shift.work_date,shift_type:shift.shift_type,start_time:cleanTime(shift.start_time),end_time:cleanTime(shift.end_time)})),now=new Date().toISOString();
  const {error:updateError}=await admin.from("shift_schedules").update({status:"published",published_snapshot:snapshot,published_at:now,published_by:authData.user.id,updated_at:now}).eq("id",schedule.id).eq("organization_id",me.organization_id);if(updateError)return json({error:updateError.message},400);
  await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"publish_roster_without_email",entity_type:"shift_schedule",entity_id:schedule.id,details:{week_start:week,shifts:shifts.length}});
  return json({published:shifts.length,email_sent:0});
});
