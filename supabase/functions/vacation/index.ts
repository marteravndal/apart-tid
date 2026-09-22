import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
const todayOslo=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date());
const addDays=(value:string,days:number)=>{const d=new Date(`${value}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
const weekdays=(from:string,to:string)=>{let count=0;for(let d=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`);d<=end;d.setUTCDate(d.getUTCDate()+1)){const day=d.getUTCDay();if(day!==0&&day!==6)count++}return count};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const sendEmail=async(to:string[],subject:string,html:string)=>{const key=Deno.env.get("RESEND_API_KEY");if(!key)return false;try{const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Apart Tid <post@apartstavanger.no>",to,subject,html})});return response.ok}catch{return false}};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name,employee_number,email").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);

  if(req.method==="GET"){
    const yearParam=Number(new URL(req.url).searchParams.get("year")||todayOslo().slice(0,4));const year=Number.isInteger(yearParam)&&yearParam>=2020&&yearParam<=2200?yearParam:Number(todayOslo().slice(0,4));
    let requests=admin.from("vacation_requests").select("id,employee_id,request_type,start_date,end_date,vacation_year,requested_days,status,employee_note,admin_comment,handled_at,created_at,employees(employee_number,full_name,email)").eq("organization_id",me.organization_id).eq("vacation_year",year).order("created_at",{ascending:false});
    let carry=admin.from("vacation_carryover_requests").select("id,employee_id,from_year,to_year,days,status,employee_note,admin_comment,handled_at,created_at,employees(employee_number,full_name,email)").eq("organization_id",me.organization_id).or(`from_year.eq.${year},to_year.eq.${year}`).order("created_at",{ascending:false});
    if(me.role!=="admin"){requests=requests.eq("employee_id",me.id);carry=carry.eq("employee_id",me.id)}
    const [{data:requestRows,error:requestError},{data:carryRows,error:carryError},{data:staff,error:staffError}]=await Promise.all([requests,carry,me.role==="admin"?admin.from("employees").select("id,employee_number,full_name").eq("organization_id",me.organization_id).eq("active",true).order("full_name"):Promise.resolve({data:[],error:null})]);if(requestError||carryError||staffError)return json({error:requestError?.message||carryError?.message||staffError?.message},400);
    const employees=(staff||[]).map((e:any)=>({employee_id:e.id,employee_number:e.employee_number,full_name:e.full_name}));
    const balanceFor=(employeeId:string)=>{const incoming=(carryRows||[]).filter((c:any)=>c.employee_id===employeeId&&c.to_year===year&&c.status==="approved").reduce((s:number,c:any)=>s+c.days,0),approved=(requestRows||[]).filter((r:any)=>r.employee_id===employeeId&&r.request_type==="vacation"&&r.status==="approved").reduce((s:number,r:any)=>s+r.requested_days,0),pending=(requestRows||[]).filter((r:any)=>r.employee_id===employeeId&&r.request_type==="vacation"&&r.status==="pending").reduce((s:number,r:any)=>s+r.requested_days,0),outgoing=(carryRows||[]).filter((c:any)=>c.employee_id===employeeId&&c.from_year===year&&c.status==="approved").reduce((s:number,c:any)=>s+c.days,0);return{year,base:25,incoming,available:25+incoming,used:approved,pending,transferred:outgoing,remaining:25+incoming-approved-outgoing}};
    return json({year,requests:requestRows||[],carryovers:carryRows||[],balance:me.role==="admin"?null:balanceFor(me.id),balances:me.role==="admin"?employees.map((e:any)=>({...e,...balanceFor(e.employee_id)})):[]});
  }

  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}const action=String(body.action||"");
  if(req.method==="POST"&&action==="submit"){
    const type=String(body.request_type||""),start=String(body.start_date||""),end=String(body.end_date||""),note=String(body.employee_note||"").trim();
    if(!["vacation","leave"].includes(type)||!dateOk(start)||!dateOk(end)||end<start)return json({error:"Velg type og en gyldig fra- og til-dato."},400);
    const earliest=addDays(todayOslo(),14);if(start<earliest)return json({error:`Ferie og permisjon må søkes senest 14 dager før oppstart (${earliest} eller senere).`},400);
    if(start.slice(0,4)!==end.slice(0,4))return json({error:"Søknaden må være innenfor samme kalenderår. Del perioden i to søknader."},400);
    const year=Number(start.slice(0,4)),days=weekdays(start,end);if(days<1)return json({error:"Perioden må inneholde minst én hverdag."},400);
    if(type==="vacation"){
      const [{data:vac},{data:carry}]=await Promise.all([admin.from("vacation_requests").select("requested_days,status").eq("employee_id",me.id).eq("vacation_year",year).eq("request_type","vacation").in("status",["pending","approved"]),admin.from("vacation_carryover_requests").select("days").eq("employee_id",me.id).eq("to_year",year).eq("status","approved")]);
      const allowance=25+(carry||[]).reduce((s,c)=>s+c.days,0),reserved=(vac||[]).reduce((s,v)=>s+v.requested_days,0);if(reserved+days>allowance)return json({error:`Du har ikke nok feriedager. Tilgjengelig før denne søknaden: ${allowance-reserved}.`},400);
    }
    const result=await admin.from("vacation_requests").insert({organization_id:me.organization_id,employee_id:me.id,request_type:type,start_date:start,end_date:end,vacation_year:year,requested_days:days,employee_note:note||null}).select("id,status,created_at").single();if(result.error)return json({error:result.error.message},400);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"submit_vacation_request",entity_type:"vacation_request",entity_id:result.data.id,details:{request_type:type,start_date:start,end_date:end,requested_days:days}});
    const label=type==="vacation"?"ferie":"permisjon";const emailSent=await sendEmail(["post@apartstavanger.no"],`Nytt ønske om ${label} fra ${me.full_name}`,`<h2>Nytt ønske i Apart Tid</h2><p><strong>${esc(me.employee_number)} · ${esc(me.full_name)}</strong></p><p>Type: ${label}<br>Periode: ${start}–${end}<br>Hverdager: ${days}</p><p>Logg inn i Apart Tid for å behandle ønsket.</p>`);
    return json({request:result.data,email_sent:emailSent},201);
  }
  if(req.method==="POST"&&action==="carryover"){
    const fromYear=Number(body.from_year),days=Number(body.days),note=String(body.employee_note||"").trim(),currentYear=Number(todayOslo().slice(0,4));if(fromYear!==currentYear||!Number.isInteger(days)||days<1||days>12)return json({error:"Du kan søke om å overføre 1–12 dager fra inneværende år."},400);
    const [{data:vac},{data:incoming},{data:outgoing}]=await Promise.all([admin.from("vacation_requests").select("requested_days").eq("employee_id",me.id).eq("vacation_year",fromYear).eq("request_type","vacation").eq("status","approved"),admin.from("vacation_carryover_requests").select("days").eq("employee_id",me.id).eq("to_year",fromYear).eq("status","approved"),admin.from("vacation_carryover_requests").select("days,status").eq("employee_id",me.id).eq("from_year",fromYear).in("status",["pending","approved"])]);
    if((outgoing||[]).length)return json({error:"Du har allerede en aktiv overføringssøknad for dette året."},409);const available=25+(incoming||[]).reduce((s,c)=>s+c.days,0)-(vac||[]).reduce((s,v)=>s+v.requested_days,0);if(days>available)return json({error:`Du har bare ${available} ubrukte feriedager tilgjengelig.`},400);
    const result=await admin.from("vacation_carryover_requests").insert({organization_id:me.organization_id,employee_id:me.id,from_year:fromYear,days,employee_note:note||null}).select("id,status,created_at").single();if(result.error)return json({error:result.error.message},400);
    await admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:"submit_vacation_carryover",entity_type:"vacation_carryover_request",entity_id:result.data.id,details:{from_year:fromYear,to_year:fromYear+1,days}});
    const emailSent=await sendEmail(["post@apartstavanger.no"],`Ny søknad om ferieoverføring fra ${me.full_name}`,`<h2>Søknad om ferieoverføring</h2><p><strong>${esc(me.employee_number)} · ${esc(me.full_name)}</strong></p><p>${days} dager fra ${fromYear} til ${fromYear+1}.</p><p>Logg inn i Apart Tid for å behandle søknaden.</p>`);return json({request:result.data,email_sent:emailSent},201);
  }
  if(req.method==="PATCH"&&["handle","handle_carryover"].includes(action)){
    if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);const id=String(body.id||""),status=String(body.status||""),comment=String(body.admin_comment||"").trim();if(!id||!["approved","rejected"].includes(status))return json({error:"Velg godkjenn eller avvis."},400);if(status==="rejected"&&comment.length<3)return json({error:"Skriv en kort kommentar ved avvisning."},400);
    const table=action==="handle"?"vacation_requests":"vacation_carryover_requests";const rpc=action==="handle"?"process_vacation_request":"process_vacation_carryover";const {data:row}=await admin.from(table).select("*,employees(full_name,email)").eq("id",id).eq("organization_id",me.organization_id).maybeSingle();if(!row)return json({error:"Søknaden finnes ikke."},404);
    const args=action==="handle"?{p_request_id:id,p_status:status,p_admin_comment:comment,p_handled_by:authData.user.id}:{p_request_id:id,p_status:status,p_admin_comment:comment,p_handled_by:authData.user.id};const {data,error}=await admin.rpc(rpc,args);if(error)return json({error:error.message},400);
    const approved=status==="approved",subject=action==="handle_carryover"?`Ferieoverføring ${approved?"godkjent":"avvist"}`:`${row.request_type==="vacation"?"Ferie":"Permisjon"} ${approved?"innvilget":"avvist"}`;const details=action==="handle_carryover"?`${row.days} dager fra ${row.from_year} til ${row.to_year}`:`${row.start_date}–${row.end_date} (${row.requested_days} hverdager)`;const emailSent=await sendEmail([row.employees.email],subject,`<h2>${esc(subject)}</h2><p>Hei ${esc(row.employees.full_name)}.</p><p>Søknaden din er <strong>${approved?"godkjent":"avvist"}</strong>.</p><p>${esc(details)}</p>${comment?`<p>Kommentar fra admin: ${esc(comment)}</p>`:""}`);
    return json({result:data,email_sent:emailSent});
  }
  return json({error:"Handling støttes ikke."},405);
});
