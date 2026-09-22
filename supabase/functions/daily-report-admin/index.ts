import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");
  if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));
  if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:employee}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();
  if(!employee?.active||employee.role!=="admin")return json({error:"Kun aktiv administrator har tilgang."},403);
  if(req.method==="GET"){
    const date=new URL(req.url).searchParams.get("date");
    let reportsQuery=admin.from("daily_reports").select("id,work_date,status,revision,locked_at,sent_at").eq("organization_id",employee.organization_id).order("work_date",{ascending:false}).order("revision",{ascending:false}).limit(90);
    if(date)reportsQuery=reportsQuery.eq("work_date",date);
    const {data:reports,error}=await reportsQuery;
    if(error)return json({error:error.message},400);
    const reportIds=(reports||[]).map(report=>report.id);
    const {data:proposals,error:proposalError}=reportIds.length?await admin.from("transport_transfer_proposals").select("id,report_id,employee_number,work_date,start_time,end_time,worked_hours,status,created_at").in("report_id",reportIds).order("employee_number"):{data:[],error:null};
    return proposalError?json({error:proposalError.message},400):json({reports,proposals});
  }
  if(req.method==="POST"){
    let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
    const workDate=String(body.work_date||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(workDate))return json({error:"Velg en gyldig dato."},400);
    const {data,error}=await admin.rpc("prepare_daily_report",{p_organization_id:employee.organization_id,p_work_date:workDate,p_actor_id:authData.user.id});
    return error?json({error:error.message},409):json({report:data},201);
  }
  return json({error:"Handling støttes ikke."},405);
});
