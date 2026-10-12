import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
const stampTime = (value: string) => new Date(value).toLocaleString("nb-NO", {timeZone:"Europe/Oslo",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});

export function notificationEmail(job: any) {
 const p=job.payload, reference=`ST-${String(p.reference_no).padStart(6,"0")}`;
 const times=`Innstemplet: ${stampTime(p.started_at)}\nAutomatisk utstemplet: ${stampTime(p.ended_at)}\nReferanse: ${reference}`;
 const text=job.recipient_kind==="employee" ? `Hei ${String(p.employee_name).split(/\s+/)[0]},

Du er automatisk stemplet ut av Apart Tid fordi du har vært registrert som innstemplet i 12 timer uten å stemple ut.

${times}

Registreringen er merket for kontroll av administrator. Den automatiske utstemplingen bekrefter ikke at du har arbeidet i 12 timer.

Dette må du gjøre nå:
Kontakt administrator så snart som mulig på post@apartstavanger.no og oppgi når du faktisk avsluttet arbeidet. Oppgi referansen over. Dersom du fortsatt er på jobb, må du også gi beskjed slik at hele arbeidstiden blir registrert korrekt.

Du har ansvar for å følge rutinene for inn- og utstempling. Stemple inn når du begynner å arbeide, og stemple ut når arbeidet er avsluttet.

Mangelfull registrering kan føre til feil i lønnsgrunnlaget og behov for korrigering av timer og tillegg. Gjentatte brudd på stemplingsrutinene vil bli fulgt opp av leder. Arbeid som faktisk er utført, skal registreres og lønnes korrekt.

Har du problemer med systemet, meld fra til administrator med en gang.

Vennlig hilsen
Apart Stavanger AS
Apart Tid` : `${p.employee_name} er automatisk utstemplet etter 12 timer.

${times}
Planlagt vakt: ${p.planned_shift ? `${p.planned_shift.work_date} kl. ${String(p.planned_shift.start_time).slice(0,5)}–${String(p.planned_shift.end_time).slice(0,5)}${p.planned_shift.end_time<=p.planned_shift.start_time?" neste dag":""}` : "Ingen tilknyttet publisert vakt funnet"}

Registreringen er merket «Automatisk utstemplet» og er ikke automatisk godkjent. Kontroller faktisk arbeidstid med den ansatte og korriger tidene ved behov før godkjenning i Ukesluttkontroll. Registreringen bekrefter ikke 12 timers utført arbeid.

Åpne Apart Tid: https://tid.apartstavanger.no/

Apart Stavanger AS · Apart Tid`;
 return {from:"Apart Tid <post@apartstavanger.no>",to:[job.recipient],subject:job.recipient_kind==="employee"?"Du er automatisk stemplet ut – kontroller arbeidstiden din":`Automatisk utstemplet – ${String(p.employee_name).replace(/[\r\n]/g," ")} – ${reference}`,text};
}

export async function handleAutoClock(req: Request) {
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 const secret=req.headers.get("x-auto-clock-secret")||"";
 if(!/^[a-f0-9]{64}$/.test(secret))return json({error:"Unauthorized"},401);
 const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret)))).map(x=>x.toString(16).padStart(2,"0")).join("");
 const {data:config,error:configError}=await admin.from("auto_clock_worker_config").select("id").eq("secret_hash",hash).maybeSingle();
 if(configError)return json({error:"Worker authentication unavailable"},503);
 if(!config)return json({error:"Unauthorized"},401);
 const key=Deno.env.get("RESEND_API_KEY");
 if(!key)return json({error:"Email service is not configured"},503);
 let sent=0,failed=0;
 for(let i=0;i<10;i++) {
  const {data:jobs,error:claimError}=await admin.rpc("claim_auto_clock_notification");
  if(claimError)return json({error:"Could not claim notification",sent,failed},503);
  const job=jobs?.[0];if(!job)break;
  let providerId:string|null=null,error:string|null=null,permanent=false;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.recipient)){error="Mottaker mangler gyldig e-postadresse.";permanent=true;}
  else try {
   const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","Idempotency-Key":`auto-clock-out/${job.id}`},body:JSON.stringify(notificationEmail(job)),signal:AbortSignal.timeout(10000)});
   const data=await response.json().catch(()=>({}));
   if(response.ok&&typeof data.id==="string")providerId=data.id;
   else {error=`E-posttjenesten svarte HTTP ${response.status}.`;permanent=response.status===422;}
  }catch{error="E-postforsøket kunne ikke bekreftes. Prøver igjen med samme referanse.";}
  const {data:finished,error:finishError}=await admin.rpc("finish_auto_clock_notification",{p_id:job.id,p_lease_token:job.lease_token,p_provider_id:providerId,p_error:error,p_permanent:permanent});
  if(finishError||!finished)return json({error:"Could not save notification result",sent,failed},503);
  if(providerId)sent++;else failed++;
  // Stay below the mail provider's request rate, including employee + ADMIN messages.
  await new Promise(resolve=>setTimeout(resolve,650));
 }
 return json({sent,failed});
}
Deno.serve(handleAutoClock);
