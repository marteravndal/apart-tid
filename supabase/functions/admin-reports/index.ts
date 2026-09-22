import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const localDate=(value:string)=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date(value));

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();
  if(!me?.active||me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  const from=String(body.from||""),to=String(body.to||""),employeeId=String(body.employee_id||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return json({error:"Ugyldig periode."},400);
  const broadFrom=new Date(`${from}T00:00:00Z`);broadFrom.setUTCDate(broadFrom.getUTCDate()-1);
  const broadTo=new Date(`${to}T23:59:59Z`);broadTo.setUTCDate(broadTo.getUTCDate()+1);
  let employeeQuery=admin.from("employees").select("id,employee_number,full_name,active").eq("organization_id",me.organization_id).order("full_name");if(employeeId)employeeQuery=employeeQuery.eq("id",employeeId);
  const [{data:employees,error:employeesError},{data:allEntries,error:entriesError},{data:allAdjustments,error:adjustmentsError}]=await Promise.all([
    employeeQuery,
    admin.from("time_entries").select("id,employee_id,kind,started_at,ended_at,source,auto_clocked_out,note").eq("organization_id",me.organization_id).gte("started_at",broadFrom.toISOString()).lte("started_at",broadTo.toISOString()).order("started_at"),
    admin.from("payroll_adjustments").select("employee_id,work_date,category,hours,note").eq("organization_id",me.organization_id).gte("work_date",from).lte("work_date",to),
  ]);
  if(employeesError||entriesError||adjustmentsError)return json({error:employeesError?.message||entriesError?.message||adjustmentsError?.message},400);
  const ids=new Set((employees||[]).map(e=>e.id));
  return json({from,to,employees:employees||[],entries:(allEntries||[]).filter(e=>ids.has(e.employee_id)&&localDate(e.started_at)>=from&&localDate(e.started_at)<=to),adjustments:(allAdjustments||[]).filter(a=>ids.has(a.employee_id))});
});
