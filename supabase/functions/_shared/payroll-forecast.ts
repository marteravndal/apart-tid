import { premiumHoursBetween } from './payroll-premiums.ts';
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
const addDays=(d:string,n:number)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const osloDate=(d:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Oslo'}).format(new Date(d));
const dow=(d:string)=>new Date(d+'T12:00:00Z').getUTCDay();
function wall(date:string,time:string){const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number),target=Date.UTC(y,m-1,d,h,min);let n=target;for(let i=0;i<3;i++){const p:any=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(n).map(x=>[x.type,x.value]));n+=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)}return n}
export function shiftBounds(s:any){return {a:wall(s.work_date,s.start_time),b:wall(s.end_time<=s.start_time?addDays(s.work_date,1):s.work_date,s.end_time)}}
function price(h:number,p:any,rate:any,rates:any){let incomplete=h>0&&rate==null,cost=h*Number(rate||0);for(const k of ['evening','night','weekend']){if(p?.[k]>0&&rates?.[k]?.hourly_rate==null)incomplete=true;cost+=Number(p?.[k]||0)*Number(rates?.[k]?.hourly_rate||0)}return {cost,incomplete}}
function intervalCost(a:number,b:number,rate:any,rates:any,sick=false){if(b<=a)return{cost:0,incomplete:false};return price((b-a)/3600000,sick?{}:premiumHoursBetween(new Date(a).toISOString(),new Date(b).toISOString()),rate,rates)}

// A forecast never writes shifts or approves payroll. All dates use the shift start date,
// matching payroll reports, including overnight shifts crossing a month boundary.
export function payrollForecast(data:any){
 const now=Date.parse(data.now),today=osloDate(data.now),people=new Map(data.employees.map((p:any)=>[p.id,p])),rows:any[]=[],warnings=new Set<string>();
 let openCount=0,longOpen=0,missingRates=0,unapproved=0,missingShifts=0,estimatedDays=0,uncoveredDays=0;
 const weekPeople=(data.weeks||[]).flatMap((w:any)=>(w.employees||[]).map((p:any)=>({...p,week:w.week_start})));
 const allEntries=weekPeople.flatMap((p:any)=>(p.entries||[]).map((e:any)=>({...e,person:p,employee_id:p.employee.id})));
 for(const day of data.days){
  const date=day.date,row:any={date,actual:0,provisional:0,remaining:0,unrecorded:0,estimate:0,planned:0,variance:0,compared_shifts:0,missing_shifts:0,estimated_slots:0,complete:day.complete,status:day.status,incomplete:false};
  const entries=allEntries.filter((e:any)=>e.work_date===date),adjustments=weekPeople.flatMap((p:any)=>(p.adjustments||[]).filter((a:any)=>a.work_date===date).map((a:any)=>({...a,person:p,employee_id:p.employee.id})));
  // For earlier days use published plans (including the frozen per-employee copy).
  // Today also uses the latest draft for upcoming shifts; entries still match published IDs.
  const shifts=day.shifts.map((s:any)=>({...s,...shiftBounds(s)}));
  const costByEntry=new Map(),entryShift=new Map(),matched=new Map<string,any[]>();
  for(const e of entries){
   const p=e.person,rate=p.summary.hourly_rate,rates=p.summary.payroll_codes,a=Date.parse(e.started_at),end=e.ended_at?Date.parse(e.ended_at):now;
   const isLong=!e.ended_at&&now-a>20*3600000;
   if(!e.ended_at){openCount++;if(isLong)longOpen++}if(!e.approved&&!p.locked)unapproved++;
   // Abnormal open entries are excluded, not silently capped or assigned an invented end time.
   const cost=isLong?{cost:0,incomplete:false}:intervalCost(a,Math.min(end,now),rate,rates,e.kind==='sick_pay');
   if(cost.incomplete){missingRates++;row.incomplete=true}costByEntry.set(e.id,cost.cost);
   row[e.ended_at?'actual':'provisional']+=cost.cost;
   const candidates=shifts.filter((s:any)=>s.employee_id===e.employee_id&&(s.id===e.scheduled_shift_id||(a<s.b&&end>s.a&&Math.abs(a-s.a)<=12*3600000))).sort((s:any,t:any)=>Number(t.id===e.scheduled_shift_id)-Number(s.id===e.scheduled_shift_id)||Math.abs(a-s.a)-Math.abs(a-t.a));
   if(candidates[0]){const s=candidates[0];entryShift.set(e.id,s.id);matched.set(s.id,[...(matched.get(s.id)||[]),e])}
  }
  const sickBalance=new Map<string,number>();
  for(const a of adjustments){if(!['sick_pay','overtime_40','overtime_100'].includes(a.category)){row.incomplete=true;missingRates++;warnings.add('En lønnsjustering har en kategori som må kontrolleres i rapportene.');continue}const p=a.person,h=Number(a.hours),factor=a.category==='overtime_40'?.4:1;const c=price(h*factor,{},p.summary.hourly_rate,{});row.actual+=c.cost;if(c.incomplete){missingRates++;row.incomplete=true}if(!a.approved&&!p.locked)unapproved++;if(a.category==='sick_pay')sickBalance.set(a.employee_id,(sickBalance.get(a.employee_id)||0)+h)}
  for(const s of shifts){
   const frozen=weekPeople.find((p:any)=>p.employee.id===s.employee_id&&p.week<=date&&addDays(p.week,6)>=date),person:any=people.get(s.employee_id);
   const rate=frozen?.locked?frozen.summary.hourly_rate:person?.hourly_rate,rates=frozen?.locked?frozen.summary.payroll_codes:data.rates;
   const full=intervalCost(s.a,s.b,rate,rates);row.planned+=full.cost;if(full.incomplete){row.incomplete=true;missingRates++}
   const matches=matched.get(s.id)||[],resolved=frozen?.shifts?.find((x:any)=>x.id===s.id)?.resolved;
   if(matches.length){
    if(matches.every((e:any)=>e.ended_at)&&s.b<=now){row.variance+=matches.reduce((n:number,e:any)=>n+costByEntry.get(e.id),0)-full.cost;row.compared_shifts++}
    if(matches.some((e:any)=>!e.ended_at)){
     if(matches.some((e:any)=>!e.ended_at&&now-Date.parse(e.started_at)>20*3600000))row.unrecorded+=full.cost;
     else row.remaining+=intervalCost(Math.max(s.a,now),s.b,rate,rates).cost;
    }
    continue;
   }
   if(resolved)continue;
   const sick=Math.min((s.b-s.a)/3600000,sickBalance.get(s.employee_id)||0);sickBalance.set(s.employee_id,(sickBalance.get(s.employee_id)||0)-sick);
   const remainingFraction=Math.max(0,1-sick/((s.b-s.a)/3600000));
   if(s.a<now){if(remainingFraction>0){row.unrecorded+=full.cost*remainingFraction;row.missing_shifts++;missingShifts++}}
   else row.remaining+=full.cost*remainingFraction;
  }
  // Extra actual shifts outside the plan belong to the comparable elapsed deviation.
  for(const e of entries)if(e.ended_at&&Date.parse(e.ended_at)<=now&&!entryShift.has(e.id))row.variance+=costByEntry.get(e.id);
  if(!day.complete&&date>=today){
   const reference=(data.baseline||[]).find((b:any)=>dow(b.date)===dow(date));
   if(!reference){uncoveredDays++;row.no_reference=true}
   else {
    // Fill missing staff slots per shift type; current shifts (even edited times/names)
    // replace their reference slot. An unmatched actual entry also occupies a slot.
    const missingSlots=reference.shifts.map((s:any)=>({...s}));
    for(const s of shifts){
     const candidates=missingSlots.map((r:any,i:number)=>({r,i})).filter((x:any)=>x.r.shift_type===s.shift_type).sort((a:any,b:any)=>Number(b.r.employee_id===s.employee_id)-Number(a.r.employee_id===s.employee_id)||Number(b.r.start_time===s.start_time)-Number(a.r.start_time===s.start_time));
     if(candidates[0])missingSlots.splice(candidates[0].i,1);
    }
    for(const e of entries.filter((x:any)=>!entryShift.has(x.id))){const a=Date.parse(e.started_at),i=missingSlots.findIndex((r:any)=>{const b=shiftBounds({...r,work_date:date});return a<b.b&&Date.parse(e.ended_at||data.now)>b.a});if(i>=0)missingSlots.splice(i,1)}
    for(const ref of missingSlots){const b=shiftBounds({...ref,work_date:date});if(b.a<now){row.no_reference=true;continue}const person:any=people.get(ref.employee_id),c=intervalCost(b.a,b.b,person?.hourly_rate,data.rates);row.estimate+=c.cost;row.estimated_slots++;if(c.incomplete){missingRates++;row.incomplete=true}}
    if(row.no_reference)uncoveredDays++;
    if(row.estimated_slots)estimatedDays++;
   }
  }else if(!day.complete&&date<today&&shifts.length===0&&entries.length===0&&adjustments.length===0){row.no_reference=true;uncoveredDays++}
  rows.push(row);
 }
 if(missingShifts)warnings.add(`${missingShifts} planlagte vakter mangler stempling. Planlagt kostnad er beholdt som uavklart i prognosen.`);
 if(longOpen)warnings.add(`${longOpen} åpne stemplinger er over 20 timer. De må kontrolleres; løpende kostnad er utelatt, og eventuell planlagt vakt beholdes som uavklart.`);
 if(missingRates)warnings.add('Timesats eller tilleggssats mangler. Beløpene viser bare kjent kostnad og er ufullstendige.');
 if(uncoveredDays)warnings.add(`${uncoveredDays} dager mangler tilstrekkelig grunnlag. Månedskostnaden er ufullstendig.`);
 if(estimatedDays&&!data.baseline_confirmed)warnings.add('Referanseuken er publisert, men er ikke bekreftet ferdig planlagt. Kontroller at bemanningen er representativ.');
 const sum=(key:string)=>rows.reduce((n,r)=>n+r[key],0),actual=sum('actual'),provisional=sum('provisional'),remaining=sum('remaining'),unrecorded=sum('unrecorded'),estimate=sum('estimate');
 return {month:data.month,updated_at:data.now,baseline_week:data.baseline_week,baseline_confirmed:data.baseline_confirmed,estimated_days:estimatedDays,uncovered_days:uncoveredDays,open_count:openCount,long_open_count:longOpen,missing_shifts:missingShifts,unapproved_count:unapproved,incomplete:missingRates>0||uncoveredDays>0||longOpen>0,
 totals:{actual:round(actual),provisional:round(provisional),remaining:round(remaining),unrecorded:round(unrecorded),estimate:round(estimate),planned:round(sum('planned')),forecast:round(actual+provisional+remaining+unrecorded+estimate),variance:round(sum('variance')),compared_shifts:sum('compared_shifts')},
 warnings:[...warnings],days:rows.map(r=>({...r,...Object.fromEntries(['actual','provisional','remaining','unrecorded','estimate','planned','variance'].map(k=>[k,round(r[k])]))}))};
}
