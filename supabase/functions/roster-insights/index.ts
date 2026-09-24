import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="GET")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active||me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  const [{data:employees,error},{data:payrollSettings,error:settingsError}]=await Promise.all([admin.from("employee_private_details").select("employee_id,position_percent,salary_type,salary_rate").eq("organization_id",me.organization_id),admin.from("payroll_settings").select("category,payroll_code,label,hourly_rate").eq("organization_id",me.organization_id).in("category",["evening","night","weekend"])]);if(error||settingsError)return json({error:error?.message||settingsError?.message},400);
  return json({employees:employees||[],payroll_settings:payrollSettings||[]});
});
