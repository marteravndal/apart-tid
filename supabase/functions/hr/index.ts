import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const sendEmail=async(to:string,subject:string,html:string)=>{const key=Deno.env.get("RESEND_API_KEY");if(!key)return false;try{return (await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Apart Tid <post@apartstavanger.no>",to:[to],subject,html})})).ok}catch{return false}};
type ContractModule={id:string;title:string;body:string;active:boolean};
const cleanModules=(value:unknown):ContractModule[]=>{if(!Array.isArray(value))return[];return value.slice(0,40).map((m:any)=>({id:String(m?.id||crypto.randomUUID()).slice(0,80),title:String(m?.title||"").trim().slice(0,200),body:String(m?.body||"").trim().slice(0,12000),active:m?.active!==false})).filter(m=>m.title.length>=1&&m.body.length>=1)};
const contractText=(text:string,employee:any)=>{const salaryType=employee.salary_type==="hourly"?"time":employee.salary_type==="monthly"?"måned":"[time/måned]",rate=employee.salary_rate==null?"[beløp]":Number(employee.salary_rate).toLocaleString("nb-NO",{minimumFractionDigits:2,maximumFractionDigits:2});return String(text).replaceAll("[dato]",employee.employed_from||"[dato]").replaceAll("[prosent]",employee.position_percent==null?"[prosent]":String(employee.position_percent)).replaceAll("[beløp]",rate).replaceAll("[time/måned]",salaryType)};
const contractPdf=async(contract:any,employee:any,adminName:string)=>{
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const width=595,height=842,margin=58,maxWidth=width-margin*2,lineHeight=14;let page=pdf.addPage([width,height]),y=height-58,pageNumber=1;
  const footer=()=>{page.drawText(String(pageNumber),{x:width/2-3,y:28,size:9,font,color:rgb(.35,.35,.35)})};
  const nextPage=()=>{footer();page=pdf.addPage([width,height]);pageNumber++;y=height-58};
  const wrap=(text:string,size:number,fontRef:any)=>{const words=String(text).replace(/\r/g,"").split(/\s+/),lines:string[]=[];let line="";for(const word of words){const candidate=line?`${line} ${word}`:word;if(fontRef.widthOfTextAtSize(candidate,size)<=maxWidth)line=candidate;else{if(line)lines.push(line);line=word}}if(line)lines.push(line);return lines};
  const drawParagraph=(text:string,size=10.5,fontRef=font,gap=8)=>{for(const paragraph of String(text).split(/\n+/)){const lines=wrap(paragraph,size,fontRef);if(y-lines.length*lineHeight<70)nextPage();for(const line of lines){page.drawText(line,{x:margin,y,size,font:fontRef,color:rgb(.08,.08,.08)});y-=lineHeight}y-=gap}};
  page.drawText("ARBEIDSAVTALE",{x:margin,y,size:20,font:bold,color:rgb(.06,.14,.12)});y-=34;
  drawParagraph(`Arbeidsgiver: APART STAVANGER AS | Kontakt: ${adminName}`,10,font,5);
  drawParagraph(`Arbeidstaker: ${employee.full_name} | ${[employee.address,[employee.postal_code,employee.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")} | E-post: ${employee.email}${employee.phone_number?` | Telefon: ${employee.phone_number}`:""}`,10,font,16);
  const modules=(contract.locked_modules||contract.modules||[]).filter((m:ContractModule)=>m.active);
  modules.forEach((m:ContractModule,index:number)=>{if(y<120)nextPage();drawParagraph(`${index+1} ${m.title}`,14,bold,7);drawParagraph(contractText(m.body,employee),10.5,font,14)});
  if(y<190)nextPage();y-=12;page.drawLine({start:{x:margin,y},end:{x:margin+190,y},thickness:.8,color:rgb(.25,.25,.25)});page.drawLine({start:{x:width-margin-190,y},end:{x:width-margin,y},thickness:.8,color:rgb(.25,.25,.25)});y-=18;
  page.drawText("Sted, dato og arbeidsgivers signatur",{x:margin,y,size:9,font});page.drawText("Sted, dato og arbeidstakers signatur",{x:width-margin-190,y,size:9,font});footer();
  const bytes=await pdf.save();let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));return btoa(binary);
};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,email").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);

  if(req.method==="GET"){
    let docs=admin.from("hr_documents").select("id,employee_id,batch_id,title,document_type,original_name,mime_type,size_bytes,requires_signature,signature_status,read_at,signed_at,created_at,storage_path,employees(employee_number,full_name,email)").eq("organization_id",me.organization_id).order("created_at",{ascending:false});
    let contracts=admin.from("hr_contracts").select("id,employee_id,title,content,locked_content,modules,locked_modules,status,version,locked_at,signed_at,created_at,updated_at,employees(employee_number,full_name,email,phone_number)").eq("organization_id",me.organization_id).order("updated_at",{ascending:false});
    if(me.role!=="admin"){docs=docs.eq("employee_id",me.id);contracts=contracts.eq("employee_id",me.id).neq("status","draft")}
    const [{data:docRows,error:docError},{data:contractRows,error:contractError},{data:staff,error:staffError}]=await Promise.all([docs,contracts,me.role==="admin"?admin.from("employees").select("id,employee_number,full_name,email,phone_number").eq("organization_id",me.organization_id).eq("active",true).order("full_name"):Promise.resolve({data:[],error:null})]);
    if(docError||contractError||staffError)return json({error:docError?.message||contractError?.message||staffError?.message},400);
    const documents=await Promise.all((docRows||[]).map(async(row:any)=>{const {data}=await admin.storage.from("hr-documents").createSignedUrl(row.storage_path,900);const {storage_path,...safe}=row;return{...safe,url:data?.signedUrl||null}}));
    return json({documents,contracts:contractRows||[],employees:staff||[],is_admin:me.role==="admin",signing_provider_configured:Boolean(Deno.env.get("SIGNICAT_CLIENT_ID"))});
  }

  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="PATCH"&&action==="mark_read"){
    const id=String(body.id||"");const result=await admin.from("hr_documents").update({read_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).eq("employee_id",me.id).eq("organization_id",me.organization_id).select("id").maybeSingle();if(result.error||!result.data)return json({error:"Dokumentet finnes ikke."},404);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"read_hr_document",entity_type:"hr_document",entity_id:id});return json({ok:true});
  }
  if(req.method==="POST"&&action==="download_contract_pdf"){
    const id=String(body.id||"");let query=admin.from("hr_contracts").select("*,employees(full_name,email,phone_number)").eq("id",id).eq("organization_id",me.organization_id).in("status",["locked","pending_signature","signed"]);if(me.role!=="admin")query=query.eq("employee_id",me.id);const {data:contract}=await query.maybeSingle();if(!contract)return json({error:"Bare en låst kontrakt kan lastes ned."},404);
    let employee=contract.locked_employee_snapshot||contract.employees;if(!contract.locked_employee_snapshot){const {data:details}=await admin.from("employee_private_details").select("address,postal_code,city,employed_from,position_percent,salary_type,salary_rate").eq("employee_id",contract.employee_id).maybeSingle();employee={...employee,...(details||{})}}const content_base64=await contractPdf(contract,employee,me.role==="admin"?me.full_name:"Apart Stavanger AS");
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"download_locked_contract_pdf",entity_type:"hr_contract",entity_id:id});
    return json({content_base64,file_name:`${contract.title.replace(/[^a-zA-Z0-9æøåÆØÅ_-]/g,"_")}-v${contract.version}.pdf`});
  }
  if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);

  if(req.method==="POST"&&action==="upload_document"){
    const title=String(body.title||"").trim(),name=String(body.file_name||"").trim(),mime=String(body.mime_type||""),encoded=String(body.content_base64||""),target=String(body.employee_id||""),requiresSignature=Boolean(body.requires_signature);
    if(title.length<2||!name||mime!=="application/pdf"||!encoded)return json({error:"Velg en PDF-fil, mottaker og navn på dokumentet."},400);if(encoded.length>14000000)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);
    let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))}catch{return json({error:"Dokumentet kunne ikke leses."},400)}if(bytes.length>10485760)return json({error:"Dokumentet er for stort. Maksimum er 10 MB."},400);
    let employeesQuery=admin.from("employees").select("id,full_name,email").eq("organization_id",me.organization_id).eq("active",true);if(target!=="all")employeesQuery=employeesQuery.eq("id",target);
    const {data:recipients,error:recipientError}=await employeesQuery;if(recipientError||!recipients?.length)return json({error:"Velg minst én aktiv ansatt."},400);
    const safe=name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100),path=`${me.organization_id}/${crypto.randomUUID()}-${safe}`,batchId=crypto.randomUUID();const upload=await admin.storage.from("hr-documents").upload(path,bytes,{contentType:mime,upsert:false});if(upload.error)return json({error:upload.error.message},400);
    const rows=recipients.map((employee:any)=>({organization_id:me.organization_id,employee_id:employee.id,batch_id:batchId,title,document_type:"general",storage_path:path,original_name:name,mime_type:mime,size_bytes:bytes.length,requires_signature:requiresSignature,signature_status:requiresSignature?"pending":"not_required",uploaded_by:authData.user.id}));
    const result=await admin.from("hr_documents").insert(rows).select("id");if(result.error){await admin.storage.from("hr-documents").remove([path]);return json({error:result.error.message},400)}
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"upload_hr_document",entity_type:"hr_document_batch",entity_id:batchId,details:{title,recipient_count:recipients.length,requires_signature:requiresSignature}});
    const notices=await Promise.all(recipients.map((employee:any)=>sendEmail(employee.email,"Nytt dokument i HR-arkivet",`<h2>Nytt HR-dokument</h2><p>Hei ${esc(employee.full_name)}.</p><p><strong>${esc(title)}</strong> er lagt i HR-arkivet ditt i Apart Tid.</p><p>Logg inn for å lese dokumentet.</p>`)));
    return json({documents:result.data,recipient_count:recipients.length,email_sent:notices.filter(Boolean).length},201);
  }
  if(req.method==="POST"&&action==="create_contract"){
    const employeeId=String(body.employee_id||""),title=String(body.title||"").trim(),modules=cleanModules(body.modules);if(!employeeId||title.length<2||!modules.some(m=>m.active))return json({error:"Velg ansatt og behold minst én aktiv kontraktsmodul."},400);
    const {data:employee}=await admin.from("employees").select("id").eq("id",employeeId).eq("organization_id",me.organization_id).eq("active",true).maybeSingle();if(!employee)return json({error:"Ansatt finnes ikke."},404);
    const result=await admin.from("hr_contracts").insert({organization_id:me.organization_id,employee_id:employeeId,title,content:"Modulbasert kontrakt",modules,created_by:authData.user.id,updated_by:authData.user.id}).select("id,status,version").single();if(result.error)return json({error:result.error.message},400);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"create_hr_contract",entity_type:"hr_contract",entity_id:result.data.id});return json({contract:result.data},201);
  }
  if(req.method==="PATCH"&&action==="update_contract"){
    const id=String(body.id||""),title=String(body.title||"").trim(),modules=cleanModules(body.modules);if(title.length<2||!modules.some(m=>m.active))return json({error:"Kontrakten må ha tittel og minst én aktiv modul."},400);
    const result=await admin.from("hr_contracts").update({title,modules,updated_by:authData.user.id,updated_at:new Date().toISOString()}).eq("id",id).eq("organization_id",me.organization_id).eq("status","draft").select("id").maybeSingle();if(result.error||!result.data)return json({error:"Bare kontrakter med status utkast kan redigeres."},409);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"update_hr_contract",entity_type:"hr_contract",entity_id:id});return json({ok:true});
  }
  if(req.method==="PATCH"&&action==="lock_contract"){
    const id=String(body.id||"");const {data:contract}=await admin.from("hr_contracts").select("id,title,content,modules,employee_id,employees(full_name,email)").eq("id",id).eq("organization_id",me.organization_id).eq("status","draft").maybeSingle();if(!contract)return json({error:"Bare et utkast kan låses."},409);
    const modules=cleanModules(contract.modules);if(!modules.some(m=>m.active))return json({error:"Kontrakten må ha minst én aktiv modul."},400);const {data:details}=await admin.from("employee_private_details").select("address,postal_code,city,employed_from,position_percent,salary_type,salary_rate").eq("employee_id",contract.employee_id).maybeSingle();const snapshot={...(contract.employees as any),...(details||{})};const now=new Date().toISOString(),result=await admin.from("hr_contracts").update({locked_content:"Modulbasert kontrakt",locked_modules:modules,locked_employee_snapshot:snapshot,status:"locked",locked_at:now,updated_by:authData.user.id,updated_at:now}).eq("id",id).eq("status","draft").select("id").maybeSingle();if(result.error||!result.data)return json({error:"Kontrakten kunne ikke låses."},409);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"lock_hr_contract",entity_type:"hr_contract",entity_id:id});
    const emailSent=await sendEmail((contract.employees as any).email,"Arbeidskontrakt klar",`<h2>Arbeidskontrakt klar</h2><p>Hei ${esc((contract.employees as any).full_name)}.</p><p><strong>${esc(contract.title)}</strong> er låst og tilgjengelig som PDF i Apart Tid. Frem til BankID-signering er aktivert kan kontrakten skrives ut og signeres manuelt.</p>`);
    return json({ok:true,email_sent:emailSent});
  }
  if(req.method==="POST"&&action==="start_signing")return json({error:"Signicat er ikke konfigurert ennå. Kontrakten er låst og klar for tilkobling."},409);
  return json({error:"Handling støttes ikke."},405);
});
