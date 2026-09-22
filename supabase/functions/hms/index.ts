import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const validStatus=(v:string)=>["new","in_progress","closed"].includes(v);
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,employee_number").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);
  if(req.method==="GET"){
    let docsQuery=admin.from("hms_documents").select("id,title,original_name,mime_type,size_bytes,active,created_at,storage_path").eq("organization_id",me.organization_id).order("created_at",{ascending:false});if(me.role!=="admin")docsQuery=docsQuery.eq("active",true);
    let deviationsQuery=admin.from("hms_deviations").select("id,employee_id,title,category,severity,description,status,admin_comment,created_at,updated_at,employees(employee_number,full_name)").eq("organization_id",me.organization_id).order("created_at",{ascending:false});if(me.role!=="admin")deviationsQuery=deviationsQuery.eq("employee_id",me.id);
    const [{data:docs,error:docsError},{data:deviations,error:devError}]=await Promise.all([docsQuery,deviationsQuery]);if(docsError||devError)return json({error:docsError?.message||devError?.message},400);
    const documents=await Promise.all((docs||[]).map(async d=>{const {data}=await admin.storage.from("hms-documents").createSignedUrl(d.storage_path,3600);const {storage_path,...safe}=d;return{...safe,url:data?.signedUrl||null}}));return json({documents,deviations:deviations||[],is_admin:me.role==="admin"});
  }
  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="POST"&&action==="submit_deviation"){
    const title=String(body.title||"").trim(),category=String(body.category||""),severity=String(body.severity||""),description=String(body.description||"").trim();if(title.length<3||description.length<10||!["fare","skade","miljo","utstyr","annet"].includes(category)||!["lav","middels","hoy"].includes(severity))return json({error:"Fyll ut alle feltene i avviksmeldingen."},400);
    const {data,error}=await admin.from("hms_deviations").insert({organization_id:me.organization_id,employee_id:me.id,title,category,severity,description}).select("id,status,created_at").single();if(error)return json({error:error.message},400);await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"submit_hms_deviation",entity_type:"hms_deviation",entity_id:data.id,details:{category,severity}});return json({deviation:data},201);
  }
  if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  if(req.method==="POST"&&action==="upload_document"){
    const title=String(body.title||"").trim(),name=String(body.file_name||"").trim(),mime=String(body.mime_type||""),encoded=String(body.content_base64||"");const allowed=["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","image/jpeg","image/png"];if(title.length<2||!name||!allowed.includes(mime)||!encoded)return json({error:"Velg PDF, Word, JPG eller PNG og gi dokumentet et navn."},400);if(encoded.length>14000000)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);
    let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))}catch{return json({error:"Dokumentet kunne ikke leses."},400)}if(bytes.length>10485760)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);const safe=name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100),path=`${me.organization_id}/${crypto.randomUUID()}-${safe}`;const upload=await admin.storage.from("hms-documents").upload(path,bytes,{contentType:mime,upsert:false});if(upload.error)return json({error:upload.error.message},400);const result=await admin.from("hms_documents").insert({organization_id:me.organization_id,title,storage_path:path,original_name:name,mime_type:mime,size_bytes:bytes.length,uploaded_by:authData.user.id}).select("id,title,active,created_at").single();if(result.error){await admin.storage.from("hms-documents").remove([path]);return json({error:result.error.message},400)}await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"upload_hms_document",entity_type:"hms_document",entity_id:result.data.id,details:{title,name,size_bytes:bytes.length}});return json({document:result.data},201);
  }
  if(req.method==="PATCH"&&action==="document_status"){
    const id=String(body.id||""),active=Boolean(body.active);const result=await admin.from("hms_documents").update({active,updated_at:new Date().toISOString()}).eq("id",id).eq("organization_id",me.organization_id).select("id").single();if(result.error)return json({error:result.error.message},400);await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:active?"activate_hms_document":"deactivate_hms_document",entity_type:"hms_document",entity_id:id});return json({ok:true});
  }
  if(req.method==="PATCH"&&action==="handle_deviation"){
    const id=String(body.id||""),status=String(body.status||""),comment=String(body.admin_comment||"").trim();if(!validStatus(status))return json({error:"Ugyldig status."},400);const now=new Date().toISOString();const result=await admin.from("hms_deviations").update({status,admin_comment:comment||null,handled_by:authData.user.id,handled_at:status==="closed"?now:null,updated_at:now}).eq("id",id).eq("organization_id",me.organization_id).select("id").single();if(result.error)return json({error:result.error.message},400);await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"handle_hms_deviation",entity_type:"hms_deviation",entity_id:id,details:{status,comment}});return json({ok:true});
  }
  return json({error:"Handling støttes ikke."},405);
});
