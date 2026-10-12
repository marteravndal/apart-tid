import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({error:'Handling støttes ikke.'},405);
 const token=req.headers.get('Authorization');if(!token?.startsWith('Bearer '))return json({error:'Mangler innlogging.'},401);
 try{
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  const {data:user,error:authError}=await admin.auth.getUser(token.slice(7));if(authError||!user.user)return json({error:'Ugyldig innlogging.'},401);
  const {data:me,error:meError}=await admin.from('employees').select('organization_id,role,active').eq('auth_user_id',user.user.id).maybeSingle();
  if(meError)return json({error:'Tilgangen kunne ikke kontrolleres.'},503);
  if(!me?.active||me.role!=='admin')return json({error:'Kun ADMIN har tilgang.'},403);
  let body:any;try{body=await req.json()}catch{return json({error:'Ugyldig forespørsel.'},400)}
  const action=body.action||'load';if(!['load','handle','reopen'].includes(action))return json({error:'Ukjent handling.'},400);
  if(action!=='load'&&(!/^[0-9a-f-]{36}$/i.test(body.id||'')||typeof body.expected!=='string'||!['open','handled'].includes(body.expected_status)||typeof body.comment!=='string'||body.comment.trim().length<3||body.comment.length>1000))return json({error:'Velg en sak og skriv en kommentar på 3–1000 tegn.'},400);
  const {data,error}=await admin.rpc('control_assistant',{p_org:me.organization_id,p_actor:user.user.id,p_action:action,p_body:action==='load'?{}:{id:body.id,expected:body.expected,expected_status:body.expected_status,comment:body.comment}});
  if(error)return json({error:action==='load'?'Kontrollen kunne ikke kjøres. Prøv igjen.':error.message},action==='load'?503:409);
  return json({...data,email_configured:Boolean(Deno.env.get('RESEND_API_KEY'))});
 }catch{return json({error:'Kontrollen er midlertidig utilgjengelig. Prøv igjen.'},503)}
});
