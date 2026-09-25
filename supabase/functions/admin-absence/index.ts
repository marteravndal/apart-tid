import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const sickTypes=["self_certification","medical_certificate","sick_child"];
const vacationTypes=["vacation","leave"];
const weekdays=(from:string,to:string)=>{let count=0;for(let day=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`);day<=end;day.setUTCDate(day.getUTCDate()+1)){const number=day.getUTCDay();if(number!==0&&number!==6)count++}return count};
const dates=(from:string,to:string)=>{const values:string[]=[];for(let day=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`);day<=end;day.setUTCDate(day.getUTCDate()+1))values.push(day.toISOString().slice(0,10));return values};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  const employeeId=String(body.employee_id||""),type=String(body.absence_type||""),start=String(body.start_date||""),end=String(body.end_date||""),note=String(body.note||"").trim();
  if(!employeeId||![...sickTypes,...vacationTypes].includes(type)||!dateOk(start)||!dateOk(end)||end<start)return json({error:"Velg ansatt, fraværstype og en gyldig periode."},400);
  if(note.length>1000)return json({error:"Merknaden kan være maksimalt 1000 tegn."},400);
  if(type!=="medical_certificate"&&sickTypes.includes(type)&&start!==end)return json({error:"Egenmelding og sykt barn registreres én dag om gangen. Bruk sykmelding for en lengre periode."},400);
  if(vacationTypes.includes(type)&&start.slice(0,4)!==end.slice(0,4))return json({error:"Ferie og permisjon må registreres innenfor samme kalenderår. Del perioden i to."},400);
  const {data:employee}=await admin.from("employees").select("id,full_name,employee_number").eq("id",employeeId).eq("organization_id",me.organization_id).eq("active",true).maybeSingle();if(!employee)return json({error:"Den ansatte finnes ikke eller er inaktiv."},404);
  const [{data:sickOverlap,error:sickOverlapError},{data:vacationOverlap,error:vacationOverlapError}]=await Promise.all([
    admin.from("sick_leave_requests").select("id").eq("organization_id",me.organization_id).eq("employee_id",employeeId).neq("status","rejected").lte("start_date",end).gte("end_date",start).limit(1).maybeSingle(),
    admin.from("vacation_requests").select("id").eq("organization_id",me.organization_id).eq("employee_id",employeeId).neq("status","rejected").lte("start_date",end).gte("end_date",start).limit(1).maybeSingle()
  ]);
  if(sickOverlapError||vacationOverlapError)return json({error:sickOverlapError?.message||vacationOverlapError?.message},400);if(sickOverlap||vacationOverlap)return json({error:`${employee.full_name} har allerede registrert fravær i hele eller deler av perioden.`},409);
  const now=new Date().toISOString();
  if(sickTypes.includes(type)){
    const result=await admin.from("sick_leave_requests").insert({organization_id:me.organization_id,employee_id:employeeId,absence_type:type,start_date:start,end_date:end,status:"approved",routine_version:"admin-manual-2026-09-25",routine_acknowledged_at:now,admin_comment:note||"Registrert manuelt av ADMIN",handled_by:authData.user.id,handled_at:now,updated_at:now}).select("id,status,created_at").single();
    if(result.error){if(result.error.code==="23505")return json({error:"Dette fraværet er allerede registrert."},409);return json({error:result.error.message},400)}
    const labels:Record<string,string>={self_certification:"Manuelt registrert egenmelding",medical_certificate:"Manuelt registrert sykmelding",sick_child:"Manuelt registrert sykt barn"};
    const adjustmentDays=dates(start,end).filter(value=>type!=="medical_certificate"||[1,2,3,4,5].includes(new Date(`${value}T12:00:00Z`).getUTCDay()));
    if(adjustmentDays.length){const rows=adjustmentDays.map(workDate=>({organization_id:me.organization_id,employee_id:employeeId,work_date:workDate,category:"sick_pay",hours:8,note:labels[type],created_by:authData.user.id,sick_leave_request_id:result.data.id}));const adjustment=await admin.from("payroll_adjustments").insert(rows);if(adjustment.error){await admin.from("sick_leave_requests").delete().eq("id",result.data.id);return json({error:adjustment.error.message},400)}}
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"admin_create_absence",entity_type:"sick_leave_request",entity_id:result.data.id,details:{employee_id:employeeId,absence_type:type,start_date:start,end_date:end,note:note||null,notification_sent:false,payroll_days:adjustmentDays.length}});
    return json({absence:{...result.data,employee_id:employeeId,absence_type:type,start_date:start,end_date:end},notification_sent:false},201);
  }
  const year=Number(start.slice(0,4)),requestedDays=Math.max(1,weekdays(start,end));
  if(type==="vacation"){
    const [{data:vacations,error:vacationError},{data:carryovers,error:carryoverError}]=await Promise.all([
      admin.from("vacation_requests").select("requested_days").eq("employee_id",employeeId).eq("vacation_year",year).eq("request_type","vacation").eq("status","approved"),
      admin.from("vacation_carryover_requests").select("days").eq("employee_id",employeeId).eq("to_year",year).eq("status","approved")
    ]);
    if(vacationError||carryoverError)return json({error:vacationError?.message||carryoverError?.message},400);const allowance=25+(carryovers||[]).reduce((sum:number,row:any)=>sum+Number(row.days),0),used=(vacations||[]).reduce((sum:number,row:any)=>sum+Number(row.requested_days),0);if(used+requestedDays>allowance)return json({error:`Den ansatte har ikke nok feriedager. Tilgjengelig: ${Math.max(0,allowance-used)}.`},409);
  }
  const result=await admin.from("vacation_requests").insert({organization_id:me.organization_id,employee_id:employeeId,request_type:type,start_date:start,end_date:end,vacation_year:year,requested_days:requestedDays,status:"approved",admin_comment:note||"Registrert manuelt av ADMIN",handled_by:authData.user.id,handled_at:now,updated_at:now}).select("id,status,created_at").single();if(result.error)return json({error:result.error.message},400);
  await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"admin_create_absence",entity_type:"vacation_request",entity_id:result.data.id,details:{employee_id:employeeId,absence_type:type,start_date:start,end_date:end,note:note||null,notification_sent:false,requested_days:requestedDays}});
  return json({absence:{...result.data,employee_id:employeeId,absence_type:type,start_date:start,end_date:end},notification_sent:false},201);
});
