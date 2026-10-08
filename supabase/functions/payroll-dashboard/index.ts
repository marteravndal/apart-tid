import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { payrollForecast } from "../_shared/payroll-forecast.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Handling støttes ikke.'},405);
 const auth=req.headers.get('Authorization');if(!auth?.startsWith('Bearer '))return json({error:'Mangler innlogging.'},401);
 try{
 const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:user,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!user.user)return json({error:'Ugyldig innlogging.'},401);
 const {data:me}=await admin.from('employees').select('organization_id,role,active').eq('auth_user_id',user.user.id).maybeSingle();if(!me?.active||me.role!=='admin')return json({error:'Kun administrator har tilgang.'},403);
 let body:any;try{body=await req.json()}catch{return json({error:'Ugyldig forespørsel.'},400)}
 const action=body.action||'load',month=String(body.month||'');
 const validDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!validDate(month)||!month.endsWith('-01')||!['load','planning','complete_day'].includes(action))return json({error:'Velg en gyldig måned og handling.'},400);
 if(action!=='load'&&(!validDate(body.date)||action==='complete_day'&&(typeof body.complete!=='boolean'||typeof body.expected!=='string')))return json({error:'Ugyldig planleggingsstatus.'},400);
 const {data,error}=await admin.rpc('payroll_dashboard',{p_org:me.organization_id,p_actor:user.user.id,p_month:month,p_action:action,p_body:body});
 if(error){console.error('Payroll dashboard rejected',error.code);return json({error:error.code==='P0001'?error.message:'Lønnskostnadene kunne ikke hentes. Prøv igjen.'},409)}
 return json(action==='load'?payrollForecast(data):data);
 }catch{console.error('Payroll dashboard failed');return json({error:'Lønnskostnadene kunne ikke beregnes. Prøv igjen.'},503)}
});
