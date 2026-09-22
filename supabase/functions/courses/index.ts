import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const appUrl=()=>Deno.env.get("APP_URL")||"https://tid.apartstavanger.no";
const sendEmail=async(to:string,subject:string,html:string)=>{const key=Deno.env.get("RESEND_API_KEY");if(!key)return false;try{return(await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Apart Tid <post@apartstavanger.no>",to:[to],subject,html})})).ok}catch{return false}};
type Module={id:string;title:string;body:string;active:boolean};
type Question={id:string;text:string;options:string[];correct_index:number;active:boolean};
const cleanModules=(value:unknown):Module[]=>Array.isArray(value)?value.slice(0,30).map((m:any)=>({id:String(m?.id||crypto.randomUUID()).slice(0,80),title:String(m?.title||"").trim().slice(0,200),body:String(m?.body||"").trim().slice(0,15000),active:m?.active!==false})).filter(m=>m.title&&m.body):[];
const cleanQuestions=(value:unknown):Question[]=>Array.isArray(value)?value.slice(0,30).map((q:any)=>{const options=Array.isArray(q?.options)?q.options.slice(0,6).map((x:unknown)=>String(x||"").trim().slice(0,500)).filter(Boolean):[];return{id:String(q?.id||crypto.randomUUID()).slice(0,80),text:String(q?.text||"").trim().slice(0,1000),options,correct_index:Number(q?.correct_index),active:q?.active!==false}}).filter(q=>q.text&&q.options.length>=2&&Number.isInteger(q.correct_index)&&q.correct_index>=0&&q.correct_index<q.options.length):[];

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,email").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);

  if(req.method==="GET"){
    if(me.role==="admin"){
      const [{data:courses,error:courseError},{data:assignments,error:assignmentError},{data:staff,error:staffError}]=await Promise.all([
        admin.from("courses").select("id,family_id,parent_version_id,title,description,modules,questions,passing_score,status,version,locked_at,created_at,updated_at").eq("organization_id",me.organization_id).order("status",{ascending:true}).order("updated_at",{ascending:false}),
        admin.from("course_assignments").select("id,course_id,employee_id,status,assigned_at,started_at,completed_at,score,attempts,employees(employee_number,full_name,email)").eq("organization_id",me.organization_id).order("assigned_at",{ascending:false}),
        admin.from("employees").select("id,employee_number,full_name,email").eq("organization_id",me.organization_id).eq("active",true).order("full_name")
      ]);if(courseError||assignmentError||staffError)return json({error:courseError?.message||assignmentError?.message||staffError?.message},400);
      return json({courses:courses||[],assignments:assignments||[],employees:staff||[],is_admin:true});
    }
    const {data,error}=await admin.from("course_assignments").select("id,status,assigned_at,started_at,completed_at,score,attempts,courses!inner(id,title,description,modules,questions,passing_score,version,status)").eq("employee_id",me.id).eq("organization_id",me.organization_id).eq("courses.status","locked").order("assigned_at",{ascending:false});
    if(error)return json({error:error.message},400);
    const assignments=(data||[]).map((row:any)=>({...row,courses:{...row.courses,questions:(row.courses.questions||[]).filter((q:Question)=>q.active).map((q:Question)=>({id:q.id,text:q.text,options:q.options}))}}));
    return json({assignments,is_admin:false});
  }

  let body:Record<string,any>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="PATCH"&&action==="start"){
    const id=String(body.assignment_id||"");const now=new Date().toISOString();const result=await admin.from("course_assignments").update({status:"in_progress",started_at:now}).eq("id",id).eq("employee_id",me.id).eq("organization_id",me.organization_id).eq("status","assigned").select("id").maybeSingle();
    if(result.error)return json({error:result.error.message},400);return json({ok:true});
  }
  if(req.method==="POST"&&action==="submit"){
    const id=String(body.assignment_id||""),answers=Array.isArray(body.answers)?body.answers:[];const {data:assignment}=await admin.from("course_assignments").select("id,status,course_id,attempts,courses!inner(questions,passing_score,status)").eq("id",id).eq("employee_id",me.id).eq("organization_id",me.organization_id).neq("status","completed").maybeSingle();if(!assignment||(assignment.courses as any).status!=="locked")return json({error:"Kurset er ikke tilgjengelig."},404);
    const questions=cleanQuestions((assignment.courses as any).questions).filter(q=>q.active);if(!questions.length)return json({error:"Kurset mangler kunnskapstest."},409);
    const byId=new Map(answers.map((a:any)=>[String(a.question_id),Number(a.option_index)]));const correct=questions.filter(q=>byId.get(q.id)===q.correct_index).length,score=Math.round(correct/questions.length*100),passed=score>=Number((assignment.courses as any).passing_score),now=new Date().toISOString();
    const attempt=await admin.from("course_attempts").insert({assignment_id:id,employee_id:me.id,score,passed,answers:questions.map(q=>({question_id:q.id,option_index:byId.has(q.id)?byId.get(q.id):null}))});if(attempt.error)return json({error:attempt.error.message},400);
    const patch:any={attempts:Number((assignment as any).attempts||0)+1,score};if(passed){patch.status="completed";patch.completed_at=now}else if(assignment.status==="assigned"){patch.status="in_progress";patch.started_at=now}const updated=await admin.from("course_assignments").update(patch).eq("id",id).select("id").maybeSingle();if(updated.error)return json({error:updated.error.message},400);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:passed?"complete_course":"attempt_course",entity_type:"course_assignment",entity_id:id,details:{score,passed}});return json({score,passed,passing_score:(assignment.courses as any).passing_score});
  }
  if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);

  if(req.method==="POST"&&action==="create"){
    const title=String(body.title||"").trim(),description=String(body.description||"").trim(),modules=cleanModules(body.modules),questions=cleanQuestions(body.questions),passingScore=Number(body.passing_score||80);if(title.length<2||!modules.some(m=>m.active)||!questions.some(q=>q.active)||passingScore<1||passingScore>100)return json({error:"Kurset må ha tittel, minst ett aktivt kapittel og minst ett gyldig spørsmål."},400);
    const result=await admin.from("courses").insert({organization_id:me.organization_id,title,description,modules,questions,passing_score:passingScore,created_by:authData.user.id,updated_by:authData.user.id}).select("id,status,version").single();if(result.error)return json({error:result.error.message},400);return json({course:result.data},201);
  }
  if(req.method==="PATCH"&&action==="update"){
    const id=String(body.id||""),title=String(body.title||"").trim(),description=String(body.description||"").trim(),modules=cleanModules(body.modules),questions=cleanQuestions(body.questions),passingScore=Number(body.passing_score||80);if(title.length<2||!modules.some(m=>m.active)||!questions.some(q=>q.active))return json({error:"Kurset må ha tittel, minst ett aktivt kapittel og minst ett gyldig spørsmål."},400);
    const result=await admin.from("courses").update({title,description,modules,questions,passing_score:passingScore,updated_by:authData.user.id,updated_at:new Date().toISOString()}).eq("id",id).eq("organization_id",me.organization_id).eq("status","draft").select("id").maybeSingle();if(result.error||!result.data)return json({error:"Bare kursutkast kan redigeres."},409);return json({ok:true});
  }
  if(req.method==="PATCH"&&action==="lock"){
    const id=String(body.id||"");const {data:course}=await admin.from("courses").select("id,modules,questions").eq("id",id).eq("organization_id",me.organization_id).eq("status","draft").maybeSingle();if(!course||!cleanModules(course.modules).some(m=>m.active)||!cleanQuestions(course.questions).some(q=>q.active))return json({error:"Kurset må ha innhold og en gyldig kunnskapstest før det låses."},409);const now=new Date().toISOString();const result=await admin.from("courses").update({status:"locked",locked_at:now,updated_by:authData.user.id,updated_at:now}).eq("id",id).eq("status","draft").select("id").maybeSingle();if(result.error||!result.data)return json({error:"Kurset kunne ikke låses."},409);return json({ok:true});
  }
  if(req.method==="POST"&&action==="new_version"){
    const id=String(body.id||"");const {data:source}=await admin.from("courses").select("*").eq("id",id).eq("organization_id",me.organization_id).eq("status","locked").maybeSingle();if(!source)return json({error:"Bare låste kurs kan kopieres til ny versjon."},409);const {data:maxRow}=await admin.from("courses").select("version").eq("family_id",source.family_id).order("version",{ascending:false}).limit(1).maybeSingle();const result=await admin.from("courses").insert({organization_id:me.organization_id,family_id:source.family_id,parent_version_id:source.id,title:source.title,description:source.description,modules:source.modules,questions:source.questions,passing_score:source.passing_score,version:Number(maxRow?.version||source.version)+1,created_by:authData.user.id,updated_by:authData.user.id}).select("id,status,version").single();if(result.error)return json({error:result.error.message},400);return json({course:result.data},201);
  }
  if(req.method==="POST"&&action==="assign"){
    const courseId=String(body.course_id||""),target=String(body.employee_id||"");const {data:course}=await admin.from("courses").select("id,title,version").eq("id",courseId).eq("organization_id",me.organization_id).eq("status","locked").maybeSingle();if(!course)return json({error:"Velg et låst kurs."},400);let query=admin.from("employees").select("id,full_name,email").eq("organization_id",me.organization_id).eq("active",true);if(target!=="all")query=query.eq("id",target);const {data:recipients}=await query;if(!recipients?.length)return json({error:"Velg minst én aktiv ansatt."},400);const rows=recipients.map((e:any)=>({organization_id:me.organization_id,course_id:courseId,employee_id:e.id,assigned_by:authData.user.id}));const {data:created,error}=await admin.from("course_assignments").upsert(rows,{onConflict:"course_id,employee_id",ignoreDuplicates:true}).select("id,employee_id");if(error)return json({error:error.message},400);const createdIds=new Set((created||[]).map((x:any)=>x.employee_id));const notices=await Promise.all(recipients.filter((e:any)=>createdIds.has(e.id)).map((e:any)=>sendEmail(e.email,"Nytt kurs i Apart Tid",`<h2>Nytt kurs</h2><p>Hei ${esc(e.full_name)}.</p><p>Kurset <strong>${esc(course.title)}</strong> (versjon ${course.version}) er klart i Apart Tid.</p><p><a href="${appUrl()}">Logg inn og åpne Kurs</a>.</p>`)));return json({assigned_count:createdIds.size,email_sent:notices.filter(Boolean).length});
  }
  return json({error:"Handling støttes ikke."},405);
});
