import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const activityTypes=["contact","dialog1","activity_review","nav_dialog2","nav_dialog3","plan_shared_sick_note","plan_shared_nav","employee_response","other"];
const responsibleParties=["employer","employee","shared","external"];
const measureStatuses=["planned","active","completed","cancelled"];

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active").eq("auth_user_id",authData.user.id).maybeSingle();
  if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);

  if(req.method==="GET"){
    const [{data:cases,error:caseError},{data:employees,error:employeeError}]=await Promise.all([
      admin.from("sick_followup_cases").select("*").eq("organization_id",me.organization_id).order("status").order("start_date",{ascending:false}),
      admin.from("employees").select("id,employee_number,full_name,email,active").eq("organization_id",me.organization_id).order("full_name")
    ]);if(caseError||employeeError)return json({error:caseError?.message||employeeError?.message},400);
    const ids=(cases||[]).map(row=>row.id);if(!ids.length)return json({cases:[],employees:employees||[],plans:[],activities:[],measures:[],requests:[]});
    const [{data:plans,error:planError},{data:activities,error:activityError},{data:measures,error:measureError},{data:links,error:linkError}]=await Promise.all([
      admin.from("sick_followup_plans").select("*").eq("organization_id",me.organization_id).in("case_id",ids).order("version",{ascending:false}),
      admin.from("sick_followup_activities").select("*").eq("organization_id",me.organization_id).in("case_id",ids).order("occurred_on",{ascending:false}),
      admin.from("sick_followup_measures").select("*").eq("organization_id",me.organization_id).in("case_id",ids).order("created_at",{ascending:false}),
      admin.from("sick_followup_case_requests").select("case_id,request_id").eq("organization_id",me.organization_id).in("case_id",ids)
    ]);if(planError||activityError||measureError||linkError)return json({error:planError?.message||activityError?.message||measureError?.message||linkError?.message},400);
    const requestIds=(links||[]).map(row=>row.request_id);let requests:unknown[]=[];
    if(requestIds.length){const result=await admin.from("sick_leave_requests").select("id,start_date,end_date,status,created_at").eq("organization_id",me.organization_id).in("id",requestIds).order("start_date",{ascending:false});if(result.error)return json({error:result.error.message},400);requests=result.data||[]}
    return json({cases:cases||[],employees:employees||[],plans:plans||[],activities:activities||[],measures:measures||[],links:links||[],requests});
  }

  let body:Record<string,unknown>;try{body=await req.json()}catch{return json({error:"Ugyldig forespørsel."},400)}
  const action=String(body.action||""),caseId=String(body.case_id||"");
  const getCase=async()=>{if(!caseId)return null;const {data}=await admin.from("sick_followup_cases").select("*").eq("id",caseId).eq("organization_id",me.organization_id).maybeSingle();return data};
  const audit=async(entityId:string,details:Record<string,unknown>)=>admin.from("audit_logs").insert({organization_id:me.organization_id,actor_id:authData.user.id,action:`sick_followup_${action}`,entity_type:"sick_followup_case",entity_id:entityId,details});

  if(req.method==="PATCH"&&action==="update_case"){
    const current=await getCase();if(!current)return json({error:"Oppfølgingssaken finnes ikke."},404);
    const percentage=Number(body.sick_leave_percentage),status=String(body.status||current.status),planRequired=body.followup_plan_required!==false,dialogRequired=body.dialog1_required!==false,planReason=String(body.followup_plan_exemption_reason||"").trim(),dialogReason=String(body.dialog1_exemption_reason||"").trim(),next=String(body.next_followup_date||"");
    if(!Number.isInteger(percentage)||percentage<1||percentage>100||!["active","closed"].includes(status))return json({error:"Kontroller sykmeldingsgrad og status."},400);
    if(!planRequired&&planReason.length<3)return json({error:"Oppgi hvorfor oppfølgingsplan ikke er nødvendig."},400);if(!dialogRequired&&dialogReason.length<3)return json({error:"Oppgi hvorfor dialogmøte ikke er nødvendig."},400);if(next&&!dateOk(next))return json({error:"Velg en gyldig neste oppfølgingsdato."},400);
    const values={sick_leave_percentage:percentage,status,followup_plan_required:planRequired,followup_plan_exemption_reason:planRequired?null:planReason,dialog1_required:dialogRequired,dialog1_exemption_reason:dialogRequired?null:dialogReason,next_followup_date:next||null,closed_at:status==="closed"?new Date().toISOString():null,updated_at:new Date().toISOString()};
    const {data,error}=await admin.from("sick_followup_cases").update(values).eq("id",caseId).eq("organization_id",me.organization_id).select().single();if(error)return json({error:error.message},400);await audit(caseId,values);return json({case:data});
  }

  if(req.method==="POST"&&action==="save_plan"){
    const current=await getCase();if(!current)return json({error:"Oppfølgingssaken finnes ikke."},404);
    const fields=["ordinary_tasks","work_ability","accommodation_options","agreed_measures","external_assistance","return_goal"] as const;const values:Record<string,unknown>={};for(const field of fields){const value=String(body[field]||"").trim();if(value.length>5000)return json({error:"Et planfelt er for langt."},400);values[field]=value||null}
    if(!String(values.ordinary_tasks||"")&&!String(values.work_ability||"")&&!String(values.accommodation_options||"")&&!String(values.agreed_measures||""))return json({error:"Fyll ut minst ett hovedfelt i oppfølgingsplanen."},400);
    const {data:last}=await admin.from("sick_followup_plans").select("version").eq("case_id",caseId).order("version",{ascending:false}).limit(1).maybeSingle();const sharedSick=body.shared_with_sick_note===true,sharedNav=body.shared_with_nav===true,ack=body.employee_acknowledged===true,next=String(body.next_review_date||"");if(next&&!dateOk(next))return json({error:"Velg en gyldig evalueringsdato."},400);
    Object.assign(values,{organization_id:me.organization_id,case_id:caseId,version:Number(last?.version||0)+1,status:ack?"acknowledged":sharedSick||sharedNav?"shared":"draft",next_review_date:next||null,shared_with_sick_note_at:sharedSick?new Date().toISOString():null,shared_with_nav_at:sharedNav?new Date().toISOString():null,employee_acknowledged_at:ack?new Date().toISOString():null,created_by:authData.user.id});
    const {data,error}=await admin.from("sick_followup_plans").insert(values).select().single();if(error)return json({error:error.message},400);await audit(caseId,{plan_id:data.id,version:data.version,status:data.status});return json({plan:data},201);
  }

  if(req.method==="POST"&&action==="add_activity"){
    const current=await getCase();if(!current)return json({error:"Oppfølgingssaken finnes ikke."},404);const type=String(body.activity_type||""),occurred=String(body.occurred_on||""),title=String(body.title||"").trim(),summary=String(body.summary||"").trim(),participants=String(body.participants||"").trim(),next=String(body.next_followup_date||"");if(!activityTypes.includes(type)||!dateOk(occurred)||title.length<2||title.length>200||summary.length>5000||participants.length>1000||next&&!dateOk(next))return json({error:"Kontroller type, dato og innhold i aktiviteten."},400);
    const values={organization_id:me.organization_id,case_id:caseId,activity_type:type,occurred_on:occurred,title,summary:summary||null,participants:participants||null,sick_note_consent:body.sick_note_consent===true,next_followup_date:next||null,created_by:authData.user.id};const {data,error}=await admin.from("sick_followup_activities").insert(values).select().single();if(error)return json({error:error.message},400);if(next)await admin.from("sick_followup_cases").update({next_followup_date:next,updated_at:new Date().toISOString()}).eq("id",caseId);await audit(caseId,{activity_id:data.id,activity_type:type,occurred_on:occurred});return json({activity:data},201);
  }

  if(req.method==="POST"&&action==="add_measure"){
    const current=await getCase();if(!current)return json({error:"Oppfølgingssaken finnes ikke."},404);const title=String(body.title||"").trim(),description=String(body.description||"").trim(),responsible=String(body.responsible_party||"shared"),status=String(body.status||"planned"),start=String(body.start_date||""),evaluation=String(body.evaluation_date||"");if(title.length<2||title.length>200||description.length>5000||!responsibleParties.includes(responsible)||!measureStatuses.includes(status)||start&&!dateOk(start)||evaluation&&!dateOk(evaluation))return json({error:"Kontroller tiltaket og datoene."},400);
    const values={organization_id:me.organization_id,case_id:caseId,title,description:description||null,responsible_party:responsible,start_date:start||null,evaluation_date:evaluation||null,status,created_by:authData.user.id};const {data,error}=await admin.from("sick_followup_measures").insert(values).select().single();if(error)return json({error:error.message},400);await audit(caseId,{measure_id:data.id,title,status});return json({measure:data},201);
  }

  if(req.method==="PATCH"&&action==="update_measure"){
    const current=await getCase();if(!current)return json({error:"Oppfølgingssaken finnes ikke."},404);const id=String(body.id||""),status=String(body.status||"");if(!id||!measureStatuses.includes(status))return json({error:"Velg gyldig tiltak og status."},400);const {data,error}=await admin.from("sick_followup_measures").update({status,updated_at:new Date().toISOString()}).eq("id",id).eq("case_id",caseId).eq("organization_id",me.organization_id).select().single();if(error)return json({error:error.message},400);await audit(caseId,{measure_id:id,status});return json({measure:data});
  }
  return json({error:"Handling støttes ikke."},405);
});
