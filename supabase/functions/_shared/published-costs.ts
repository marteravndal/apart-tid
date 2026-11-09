import { shiftBounds } from './payroll-forecast.ts';
import { premiumHoursBetween } from './payroll-premiums.ts';

const addDays=(date:string,n:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const monday=(date:string)=>addDays(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
const monthEnd=(date:string)=>new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7)),0,12)).toISOString().slice(0,10);
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export function publishedCostPeriods(date:string){
 const first=date.slice(0,7)+'-01',previousEnd=addDays(first,-1),previousFirst=previousEnd.slice(0,7)+'-01';
 const previousDay=previousFirst.slice(0,8)+String(Math.min(Number(date.slice(8)),Number(previousEnd.slice(8)))).padStart(2,'0');
 const week=monday(date),previousWeek=monday(previousDay);
 return [
  {key:'day',start:date,end:date,previous_start:previousDay,previous_end:previousDay},
  {key:'week',start:week,end:addDays(week,6),previous_start:previousWeek,previous_end:addDays(previousWeek,6)},
  {key:'month',start:first,end:monthEnd(date),previous_start:previousFirst,previous_end:previousEnd}
 ];
}

// Only the current published snapshot is a source. Draft rows, time entries and
// inferred shifts are intentionally absent. Costs follow the shift start date.
export function publishedCosts(date:string,schedules:any[],employees:any[],rates:any,now=new Date().toISOString()){
 const plans=new Map(schedules.filter(s=>s.status==='published'&&s.published_at&&Array.isArray(s.published_snapshot)).map(s=>[s.week_start,s]));
 const people=new Map(employees.map(p=>[p.employee_id,p]));
 const days=new Map<string,any>();
 function dayCost(day:string){
  if(days.has(day))return days.get(day);
  const schedule=plans.get(monday(day)),result={cost:0,hours:0,shifts:0,missing_rates:0,invalid_shifts:0,published:Boolean(schedule)};
  for(const raw of schedule?.published_snapshot||[]){
   if(raw.work_date!==day)continue;
   result.shifts++;
   const s={...raw,start_time:String(raw.start_time).slice(0,5),end_time:String(raw.end_time).slice(0,5)};
   const validTime=(t:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
   if(!validTime(s.start_time)||!validTime(s.end_time)){result.invalid_shifts++;continue}
   const {a,b}=shiftBounds(s),hours=(b-a)/3600000;
   if(!Number.isFinite(hours)||hours<=0){result.invalid_shifts++;continue}
   const p=people.get(s.employee_id),rate=p?.salary_type==='hourly'?p.salary_rate:null;
   const validRate=(r:any)=>r!==null&&r!==undefined&&r!==''&&Number.isFinite(Number(r))&&Number(r)>=0;
   let missing=!validRate(rate),cost=hours*(validRate(rate)?Number(rate):0);
   const premiums=premiumHoursBetween(new Date(a).toISOString(),new Date(b).toISOString());
   for(const key of ['evening','night','weekend'] as const){
    if(!premiums[key])continue;
    const extra=rates[key]?.hourly_rate;
    if(!validRate(extra))missing=true;else cost+=premiums[key]*Number(extra);
   }
   result.cost+=cost;result.hours+=hours;if(missing)result.missing_rates++;
  }
  days.set(day,result);return result;
 }
 function total(start:string,end:string){
  const result={start,end,cost:0,hours:0,shifts:0,published_days:0,total_days:0,missing_rates:0,invalid_shifts:0,complete:false};
  for(let day=start;day<=end;day=addDays(day,1)){
   const d=dayCost(day);result.total_days++;result.published_days+=Number(d.published);
   for(const key of ['cost','hours','shifts','missing_rates','invalid_shifts'] as const)result[key]+=d[key];
  }
  result.complete=result.published_days===result.total_days&&!result.missing_rates&&!result.invalid_shifts;
  result.cost=round(result.cost);result.hours=round(result.hours);return result;
 }
 const periods=publishedCostPeriods(date).map(p=>{
  const current=total(p.start,p.end),previous=total(p.previous_start,p.previous_end),comparable=current.complete&&previous.complete;
  const change=comparable?round(current.cost-previous.cost):null;
  return {key:p.key,current,previous,change,percent:comparable&&previous.cost>0?round((current.cost-previous.cost)/previous.cost*100):null};
 });
 const used=[...plans.values()].filter(s=>[...days.keys()].some(d=>monday(d)===s.week_start));
 return {date,updated_at:now,last_published_at:used.map(s=>s.published_at).sort().at(-1)||null,periods};
}

export async function loadPublishedCosts(admin:any,organizationId:string,date:string){
 const periods=publishedCostPeriods(date),starts=periods.flatMap(p=>[p.start,p.previous_start]).sort(),ends=periods.flatMap(p=>[p.end,p.previous_end]).sort();
 const schedules=await admin.from('shift_schedules').select('week_start,status,published_at,published_snapshot').eq('organization_id',organizationId).eq('status','published').gte('week_start',monday(starts[0])).lte('week_start',monday(ends.at(-1)!));
 if(schedules.error)throw new Error('Published schedules could not be read');
 const ids=[...new Set((schedules.data||[]).flatMap((s:any)=>(s.published_snapshot||[]).map((x:any)=>x.employee_id)))];
 const employees:any[]=[];
 // Batches keep both URL size and row limits bounded; inactive staff remain included.
 for(let offset=0;offset<ids.length;offset+=100){
  const result=await admin.from('employee_private_details').select('employee_id,salary_type,salary_rate').eq('organization_id',organizationId).in('employee_id',ids.slice(offset,offset+100));
  if(result.error)throw new Error('Salary rates could not be read');employees.push(...result.data||[]);
 }
 const settings=await admin.from('payroll_settings').select('category,hourly_rate').eq('organization_id',organizationId);
 if(settings.error)throw new Error('Premium rates could not be read');
 return publishedCosts(date,schedules.data||[],employees,Object.fromEntries((settings.data||[]).map((r:any)=>[r.category,{hourly_rate:r.hourly_rate}])));
}
