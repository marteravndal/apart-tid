import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const sections=["courses","hr","hms","bulletin"];

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);

  if(req.method==="GET"){
    let documentsQuery=admin.from("bulletin_documents").select("id,title,original_name,mime_type,size_bytes,active,created_at,storage_path").eq("organization_id",me.organization_id).order("created_at",{ascending:false});
    if(me.role!=="admin")documentsQuery=documentsQuery.eq("active",true);
    const {data:documentRows,error:documentError}=await documentsQuery;if(documentError)return json({error:documentError.message},400);
    const documents=await Promise.all((documentRows||[]).map(async(row:any)=>{const {data}=await admin.storage.from("bulletin-documents").createSignedUrl(row.storage_path,3600);const {storage_path,...safe}=row;return{...safe,url:data?.signedUrl||null}}));
    if(me.role==="admin")return json({documents,is_admin:true,notifications:{courses:0,hr:0,hms:0,bulletin:0}});

    const [{data:viewRows},{data:courseRows},{data:hrRows},{data:hmsRows},{data:deviationRows}]=await Promise.all([
      admin.from("employee_section_views").select("section,viewed_at").eq("employee_id",me.id).eq("organization_id",me.organization_id),
      admin.from("course_assignments").select("assigned_at").eq("employee_id",me.id).eq("organization_id",me.organization_id),
      admin.from("hr_documents").select("created_at").eq("employee_id",me.id).eq("organization_id",me.organization_id),
      admin.from("hms_documents").select("created_at").eq("organization_id",me.organization_id).eq("active",true),
      admin.from("hms_deviations").select("updated_at").eq("employee_id",me.id).eq("organization_id",me.organization_id)
    ]);
    const viewed=Object.fromEntries((viewRows||[]).map((row:any)=>[row.section,row.viewed_at]));
    const after=(value:string|undefined,section:string)=>new Date(value||0)>new Date(viewed[section]||0);
    const notifications={
      courses:(courseRows||[]).filter((row:any)=>after(row.assigned_at,"courses")).length,
      hr:(hrRows||[]).filter((row:any)=>after(row.created_at,"hr")).length,
      hms:(hmsRows||[]).filter((row:any)=>after(row.created_at,"hms")).length+(deviationRows||[]).filter((row:any)=>after(row.updated_at,"hms")).length,
      bulletin:documents.filter((row:any)=>after(row.created_at,"bulletin")).length
    };
    return json({documents:documents.map((row:any)=>({...row,is_new:after(row.created_at,"bulletin")})),notifications,is_admin:false});
  }

  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="POST"&&action==="mark_viewed"){
    const section=String(body.section||"");if(!sections.includes(section))return json({error:"Ugyldig seksjon."},400);
    const result=await admin.from("employee_section_views").upsert({organization_id:me.organization_id,employee_id:me.id,section,viewed_at:new Date().toISOString()},{onConflict:"employee_id,section"});if(result.error)return json({error:result.error.message},400);
    return json({ok:true});
  }
  if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  if(req.method==="POST"&&action==="upload_document"){
    const title=String(body.title||"").trim(),name=String(body.file_name||"").trim(),mime=String(body.mime_type||""),encoded=String(body.content_base64||"");
    const allowed=["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","image/jpeg","image/png"];
    if(title.length<2||!name||!allowed.includes(mime)||!encoded)return json({error:"Velg PDF, Word, JPG eller PNG og gi dokumentet et navn."},400);if(encoded.length>14000000)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);
    let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))}catch{return json({error:"Dokumentet kunne ikke leses."},400)}if(bytes.length>10485760)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);
    const safe=name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100),path=`${me.organization_id}/${crypto.randomUUID()}-${safe}`;
    const upload=await admin.storage.from("bulletin-documents").upload(path,bytes,{contentType:mime,upsert:false});if(upload.error)return json({error:upload.error.message},400);
    const result=await admin.from("bulletin_documents").insert({organization_id:me.organization_id,title,storage_path:path,original_name:name,mime_type:mime,size_bytes:bytes.length,uploaded_by:authData.user.id}).select("id,title,created_at").single();if(result.error){await admin.storage.from("bulletin-documents").remove([path]);return json({error:result.error.message},400)}
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"upload_bulletin_document",entity_type:"bulletin_document",entity_id:result.data.id,details:{title,name,size_bytes:bytes.length}});
    return json({document:result.data},201);
  }
  if(req.method==="DELETE"&&action==="delete_document"){
    const id=String(body.id||"");const {data:document}=await admin.from("bulletin_documents").select("id,title,original_name,storage_path").eq("id",id).eq("organization_id",me.organization_id).maybeSingle();if(!document)return json({error:"Dokumentet finnes ikke."},404);
    const deleted=await admin.from("bulletin_documents").delete().eq("id",id).eq("organization_id",me.organization_id).select("id").maybeSingle();if(deleted.error||!deleted.data)return json({error:"Dokumentet kunne ikke slettes."},400);
    const storage=await admin.storage.from("bulletin-documents").remove([document.storage_path]);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"delete_bulletin_document",entity_type:"bulletin_document",entity_id:id,details:{title:document.title,original_name:document.original_name,storage_removed:!storage.error}});
    return json({ok:true,storage_removed:!storage.error,...(storage.error?{warning:"Dokumentoppføringen er slettet, men filoppryddingen må prøves igjen senere."}:{})});
  }
  return json({error:"Handling støttes ikke."},405);
});
