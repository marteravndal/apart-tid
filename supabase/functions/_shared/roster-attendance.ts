import { shiftBounds } from './payroll-forecast.ts';

const hour=3600000;
const dayAfter=(date:string,n:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};

// A display association, never a payroll mutation. Keep persisted links distinct
// from inferred matches; several punches can belong to a single roster shift.
export function matchRosterAttendance(shifts:any[],entries:any[],requestedIds:string[],now=Date.now()){
 const wanted=new Set(requestedIds),plans=shifts.map(s=>({...s,...shiftBounds({...s,start_time:String(s.start_time).slice(0,5),end_time:String(s.end_time).slice(0,5)})}));
 const result:any[]=[];
 const add=(e:any,s:any,method:string)=>{if(wanted.has(s.id))result.push({id:e.id,reference_no:e.reference_no,employee_id:e.employee_id,scheduled_shift_id:e.scheduled_shift_id,matched_shift_id:s.id,match_method:method,kind:e.kind,source:e.source,started_at:e.started_at,ended_at:e.ended_at,auto_clocked_out:Boolean(e.auto_clocked_out)})};
 for(const e of entries){
  if(e.scheduled_shift_id){const s=plans.find(s=>s.id===e.scheduled_shift_id);if(s)add(e,s,s.employee_id===e.employee_id?'linked':'linked_conflict');continue}
  if(!['work','sick_pay'].includes(e.kind))continue;
  const a=Date.parse(e.started_at),b=e.ended_at?Date.parse(e.ended_at):Math.max(now,a+1);
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)continue;
  const candidates=plans.filter(s=>s.employee_id===e.employee_id&&Math.abs(s.a-a)<=12*hour).map(s=>({s,overlap:Math.max(0,Math.min(b,s.b)-Math.max(a,s.a)),distance:Math.abs(s.a-a)}))
   .filter(c=>e.ended_at?c.overlap>0:a>=c.s.a-2*hour&&a<c.s.b)
   .sort((x,y)=>e.ended_at?y.overlap-x.overlap||x.distance-y.distance:x.distance-y.distance);
  if(!candidates.length)continue;
  const best=candidates[0];
  // Don't silently assign a long interval spanning two shifts, or choose between
  // duplicate/overlapping slots. The administrator sees the references to check.
  const ambiguous=candidates.filter(c=>c===best||(e.ended_at
   ? c.overlap>=hour&&best.overlap>=hour||Math.abs(c.overlap-best.overlap)<=15*60000&&Math.abs(c.distance-best.distance)<=15*60000
   : Math.abs(c.distance-best.distance)<=15*60000));
  if(ambiguous.length>1)for(const c of ambiguous)add(e,c.s,'ambiguous');
  else add(e,best.s,'time');
 }
 return result.sort((a,b)=>a.started_at.localeCompare(b.started_at));
}

export async function loadRosterAttendance(admin:any,org:string,ids:string[]){
 if(!ids.length)return [];
 const selected=await admin.from('scheduled_shifts').select('id,employee_id,work_date,start_time,end_time').eq('organization_id',org).in('id',ids);
 if(selected.error||!selected.data?.length)throw new Error('Could not read requested shifts');
 const dates=selected.data.map((s:any)=>s.work_date).sort(),first=dates[0],last=dates.at(-1);
 if(Date.parse(last)-Date.parse(first)>6*24*hour)throw new Error('Only one roster week may be requested');
 const people=[...new Set(selected.data.map((s:any)=>s.employee_id))];
 // Neighbouring days prevent an early midnight punch or an overnight boundary
 // from being incorrectly attached to another shift in the selected week.
 const context=await admin.from('scheduled_shifts').select('id,employee_id,work_date,start_time,end_time').eq('organization_id',org).gte('work_date',dayAfter(first,-1)).lte('work_date',dayAfter(last,1)).in('employee_id',people).limit(1001);
 if(context.error||context.data?.length>1000)throw new Error('Could not read roster context');
 const from=shiftBounds({work_date:first,start_time:'00:00',end_time:'23:59'}).a-12*hour;
 const until=shiftBounds({work_date:dayAfter(last,2),start_time:'00:00',end_time:'23:59'}).a;
 const fields='id,reference_no,employee_id,scheduled_shift_id,kind,source,started_at,ended_at,auto_clocked_out';
 const [linked,timed]=await Promise.all([
  admin.from('time_entries').select(fields).eq('organization_id',org).in('scheduled_shift_id',ids),
  admin.from('time_entries').select(fields).eq('organization_id',org).in('employee_id',people).gte('started_at',new Date(from).toISOString()).lt('started_at',new Date(until).toISOString()).limit(1001)
 ]);
 if(linked.error||timed.error||timed.data?.length>1000)throw new Error('Could not read attendance');
 const entries=[...new Map([...(linked.data||[]),...(timed.data||[])].map((e:any)=>[e.id,e])).values()];
 return matchRosterAttendance(context.data||[],entries,ids);
}
