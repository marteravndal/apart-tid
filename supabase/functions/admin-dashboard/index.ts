import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"GET, OPTIONS","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const dateOk=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const addDays=(value:string,days:number)=>{const d=new Date(`${value}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
const monday=(value:string)=>{const d=new Date(`${value}T12:00:00Z`),day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()-day+1);return d.toISOString().slice(0,10)};
const todayOslo=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date());
const osloDate=(value:string)=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Oslo"}).format(new Date(value));
const cleanTime=(value:unknown)=>String(value||"").slice(0,5);
const duration=(start:string,end:string)=>{const value=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3,5));let minutes=value(end)-value(start);if(minutes<=0)minutes+=1440;return minutes/60};

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="GET")return json({error:"Handling støttes ikke."},405);
  const auth=req.headers.get("Authorization");if(!auth?.startsWith("Bearer "))return json({error:"Mangler innlogging."},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await admin.auth.getUser(auth.slice(7));if(authError||!authData.user)return json({error:"Ugyldig innlogging."},401);
  const {data:me}=await admin.from("employees").select("id,organization_id,role,active,full_name").eq("auth_user_id",authData.user.id).maybeSingle();if(!me?.active)return json({error:"Brukeren er ikke aktiv."},403);if(me.role!=="admin")return json({error:"Kun administrator har tilgang."},403);
  const requested=new URL(req.url).searchParams.get("date")||todayOslo(),date=dateOk(requested)?requested:todayOslo(),week=monday(date);
  const [staffResult,scheduleResult,vacationResult,sickResult,entriesResult,openEntriesResult,pendingVacationResult,pendingCarryResult,hmsResult,contractsResult]=await Promise.all([
    admin.from("employees").select("id,employee_number,full_name").eq("organization_id",me.organization_id).eq("active",true).order("full_name"),
    admin.from("shift_schedules").select("id,status,published_snapshot,published_at").eq("organization_id",me.organization_id).eq("week_start",week).maybeSingle(),
    admin.from("vacation_requests").select("id,employee_id,request_type,start_date,end_date,status,created_at,employees(full_name)").eq("organization_id",me.organization_id).eq("status","approved").lte("start_date",date).gte("end_date",date),
    admin.from("sick_leave_requests").select("id,employee_id,absence_type,start_date,end_date,status,created_at,employees(full_name)").eq("organization_id",me.organization_id).neq("status","rejected").lte("start_date",date).gte("end_date",date),
    admin.from("time_entries").select("id,employee_id,started_at,ended_at,employees(full_name)").eq("organization_id",me.organization_id).gte("started_at",`${addDays(date,-1)}T20:00:00Z`).lt("started_at",`${addDays(date,1)}T04:00:00Z`).order("started_at",{ascending:false}),
    admin.from("time_entries").select("id,employee_id,started_at,ended_at,employees(full_name)").eq("organization_id",me.organization_id).is("ended_at",null),
    admin.from("vacation_requests").select("id,employee_id,request_type,created_at,employees(full_name)").eq("organization_id",me.organization_id).eq("status","pending").order("created_at",{ascending:false}).limit(20),
    admin.from("vacation_carryover_requests").select("id,employee_id,created_at,employees(full_name)").eq("organization_id",me.organization_id).eq("status","pending").order("created_at",{ascending:false}).limit(20),
    admin.from("hms_deviations").select("id,title,severity,status,created_at,employees(full_name)").eq("organization_id",me.organization_id).in("status",["new","in_progress"]).order("created_at",{ascending:false}).limit(20),
    admin.from("hr_contracts").select("id,title,status,updated_at,employees(full_name)").eq("organization_id",me.organization_id).eq("status","draft").order("updated_at",{ascending:false}).limit(20)
  ]);
  const error=[staffResult,scheduleResult,vacationResult,sickResult,entriesResult,openEntriesResult,pendingVacationResult,pendingCarryResult,hmsResult,contractsResult].find(x=>x.error)?.error;if(error)return json({error:error.message},400);
  const staff=staffResult.data||[],schedule=scheduleResult.data,rosterActive=schedule?.status==="published",snapshot=Array.isArray(schedule?.published_snapshot)?schedule.published_snapshot:[],todayShifts=snapshot.filter((x:any)=>x.work_date===date),vacations=vacationResult.data||[],sick=sickResult.data||[],entries=(entriesResult.data||[]).filter((x:any)=>osloDate(x.started_at)===date),openEntries=openEntriesResult.data||[];
  const absenceMap=new Map<string,{type:string,label:string}>();vacations.forEach((x:any)=>absenceMap.set(x.employee_id,{type:x.request_type,label:x.request_type==="vacation"?"Ferie":"Permisjon"}));sick.forEach((x:any)=>absenceMap.set(x.employee_id,{type:"sick",label:"Sykefravær"}));
  const openMap=new Map(openEntries.map((x:any)=>[x.employee_id,x]));
  const shiftMap=new Map(todayShifts.map((x:any)=>[x.employee_id,x]));
  const expectedIds=new Set<string>(rosterActive?todayShifts.filter((x:any)=>!absenceMap.has(x.employee_id)).map((x:any)=>x.employee_id):staff.filter((x:any)=>!absenceMap.has(x.id)).map((x:any)=>x.id));
  const relevantIds=new Set<string>([...expectedIds,...absenceMap.keys()]);
  const people=staff.filter((x:any)=>relevantIds.has(x.id)).map((employee:any)=>{const absence=absenceMap.get(employee.id),shift:any=shiftMap.get(employee.id),entry:any=openMap.get(employee.id);return{id:employee.id,employee_number:employee.employee_number,full_name:employee.full_name,status:absence?"away":entry?"clocked_in":"expected",status_label:absence?absence.label:entry?"Stemplet inn":shift?"Kommer senere":"Forventet",detail:absence?.label||(shift?`${({day:"Dagskift",evening:"Kveldsskift",night:"Nattskift"} as any)[shift.shift_type]} · ${cleanTime(shift.start_time).replace(":",".")}–${cleanTime(shift.end_time).replace(":",".")}`:"Aktiv ansatt")}});
  const plannedHours=rosterActive?todayShifts.reduce((sum:number,x:any)=>sum+duration(cleanTime(x.start_time),cleanTime(x.end_time)),0):null;
  const pendingVacation=[...(pendingVacationResult.data||[]),...(pendingCarryResult.data||[])],hms=hmsResult.data||[],contracts=contractsResult.data||[],taskCount=pendingVacation.length+hms.length+contracts.length+openEntries.length;
  const activity:any[]=[];entries.slice(0,8).forEach((x:any)=>activity.push({type:"clock",text:`${x.employees?.full_name||"Ansatt"} ${x.ended_at?"stemplet ut":"stemplet inn"}`,at:x.ended_at||x.started_at}));pendingVacation.filter((x:any)=>osloDate(x.created_at)===date).slice(0,4).forEach((x:any)=>activity.push({type:"vacation",text:`Nytt ferieønske fra ${x.employees?.full_name||"ansatt"}`,at:x.created_at}));hms.filter((x:any)=>osloDate(x.created_at)===date).slice(0,4).forEach((x:any)=>activity.push({type:"hms",text:`Nytt HMS-avvik: ${x.title}`,at:x.created_at}));activity.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  return json({date,admin_name:me.full_name,roster_active:rosterActive,summary:{expected:expectedIds.size,active_staff:staff.length,clocked_in:openMap.size,tasks:taskCount,planned_hours:plannedHours},people,tasks:[{type:"vacation",label:`${pendingVacation.length} ferieønske${pendingVacation.length===1?"":"r"}`,detail:"Venter på behandling",count:pendingVacation.length,target:"vacationAdminPanel"},{type:"hms",label:`${hms.length} HMS-avvik`,detail:hms.some((x:any)=>x.severity==="hoy")?"Minst ett med høy alvorlighetsgrad":"Venter på oppfølging",count:hms.length,target:"hmsAdminPanel"},{type:"contract",label:`${contracts.length} kontraktsutkast`,detail:"Klare for videre arbeid",count:contracts.length,target:"hrAdminPanel"},{type:"clock",label:`${openEntries.length} åpne stemplinger`,detail:"Kontroller aktive registreringer",count:openEntries.length,target:"employeesPanel"}],activity:activity.slice(0,8)});
});
