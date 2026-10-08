import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { weeklyReportPdf } from "../_shared/weekly-report.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Handling støttes ikke."},405);
 const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
 const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
 const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
 const {data:me}=await admin.from("employees").select("organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();
 if(!me?.active||me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
 let body:Record<string,any>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
 const action=String(body.action||"load"),week=String(body.week_start||"");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(week)||!Number.isFinite(Date.parse(week))||new Date(`${week}T12:00:00Z`).getUTCDay()!==1)return json({error:"Velg en gyldig uke som starter mandag."},400);
 if(!["load","report","export_pdf","approve","resolve_shift","correct","lock_employee","lock_week","reopen_employee","reopen_week"].includes(action))return json({error:"Ukjent handling."},400);
 if(body.employee_id&&!/^[0-9a-f-]{36}$/i.test(body.employee_id)||body.report_id&&!/^[0-9a-f-]{36}$/i.test(body.report_id))return json({error:"Ugyldig referanse."},400);
 const {data,error}=await admin.rpc("weekly_review",{p_org:me.organization_id,p_actor:authData.user.id,p_week:week,p_action:action==="export_pdf"?"report":action,p_body:body});
 if(error){console.error("Weekly review rejected",error.code);return json({error:error.code==="P0001"?error.message:"Ukesluttkontrollen kunne ikke oppdateres. Kontroller valgene og prøv igjen."},409)}
 if(action==="export_pdf"){
  try{const bytes=await weeklyReportPdf(data);let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));return json({file_name:`apart-ukerapport-${week}-v${data.revision}.pdf`,content_base64:btoa(binary)})}
  catch{console.error("Weekly report PDF failed");return json({error:"PDF-en kunne ikke opprettes. Rapporten er fortsatt lagret, og kan eksporteres til CSV."},503)}
 }
 return json(data);
});
