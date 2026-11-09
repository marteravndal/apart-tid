const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{stripTypeScriptTypes}=require('node:module');
const compile=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''));
const premium=new Function(compile('supabase/functions/_shared/payroll-premiums.ts')+';return premiumHoursBetween')();
const {shiftBounds}=new Function('premiumHoursBetween',compile('supabase/functions/_shared/payroll-forecast.ts')+';return {shiftBounds}')(premium);
const {publishedCosts,publishedCostPeriods,loadPublishedCosts}=new Function('shiftBounds','premiumHoursBetween',compile('supabase/functions/_shared/published-costs.ts')+';return {publishedCosts,publishedCostPeriods,loadPublishedCosts}')(shiftBounds,premium);
const rates={evening:{hourly_rate:10},night:{hourly_rate:20},weekend:{hourly_rate:30}},people=[{employee_id:'e',salary_type:'hourly',salary_rate:200}];
const shift=(work_date,patch={})=>({id:'s',employee_id:'e',work_date,start_time:'08:00:00',end_time:'16:00:00',...patch});
const plan=(week_start,shifts=[],patch={})=>({week_start,status:'published',published_at:'2026-11-08T09:00:00Z',published_snapshot:shifts,...patch});
const calculate=(date,plans,p=people,r=rates)=>publishedCosts(date,plans,p,r,'2026-11-09T10:00:00Z');
test('same date last month, Monday–Sunday weeks, full months and short-month clamping',()=>{
 const p=publishedCostPeriods('2026-11-09');assert.deepEqual(p[1],{key:'week',start:'2026-11-09',end:'2026-11-15',previous_start:'2026-10-05',previous_end:'2026-10-11'});
 assert.equal(p[2].end,'2026-11-30');assert.equal(p[2].previous_end,'2026-10-31');
 assert.equal(publishedCostPeriods('2026-03-31')[0].previous_start,'2026-02-28');assert.equal(publishedCostPeriods('2024-03-31')[0].previous_start,'2024-02-29');assert.equal(publishedCostPeriods('2026-01-01')[0].previous_start,'2025-12-01');
});
test('only latest published snapshot: drafts, inactive plans and unpublished rows never contribute',()=>{
 const plans=[plan('2026-11-09',[shift('2026-11-09')],{scheduled_shifts:[shift('2026-11-09',{end_time:'23:00'})]}),plan('2026-10-05',[shift('2026-10-09')])];
 let r=calculate('2026-11-09',plans).periods[0];assert.equal(r.current.cost,1600);assert.equal(r.change,0);
 plans[0].published_snapshot=[shift('2026-11-09',{end_time:'18:00'})];r=calculate('2026-11-09',plans).periods[0];assert.equal(r.current.cost,2000);assert.equal(r.change,400);assert.equal(r.percent,25);
 for(const status of ['draft','inactive']){plans[0].status=status;r=calculate('2026-11-09',plans).periods[0];assert.equal(r.current.published_days,0);assert.equal(r.change,null)}
});
test('midnight nights stay on their date; overnight and month boundaries use start date',()=>{
 const r=calculate('2026-10-31',[plan('2026-10-26',[shift('2026-10-31',{start_time:'23:00',end_time:'07:00'})])]);
 assert.equal(r.periods[0].current.hours,8);assert.equal(r.periods[0].current.cost,1780);
 const nov=calculate('2026-11-01',[plan('2026-10-26',[shift('2026-10-31',{start_time:'23:00',end_time:'07:00'}),shift('2026-11-01',{start_time:'00:00',end_time:'06:00'})])]);assert.equal(nov.periods[0].current.cost,1320);assert.equal(nov.periods[2].current.cost,1320);
});
test('weekday evening, weekend, and DST premiums match existing payroll rules',()=>{
 for(const [date,week,start,end,hours,cost] of [['2026-11-09','2026-11-09','21:00','00:00',3,630],['2026-11-14','2026-11-09','18:00','00:00',6,1380],['2026-10-25','2026-10-19','00:00','06:00',7,1540],['2026-03-29','2026-03-23','00:00','06:00',5,1100]]){
  const r=calculate(date,[plan(week,[shift(date,{start_time:start,end_time:end})])]).periods[0].current;assert.equal(r.hours,hours);assert.equal(r.cost,cost);
 }
});
test('missing publication, missing salary and missing premium suppress misleading savings',()=>{
 const plans=[plan('2026-11-09',[shift('2026-11-09')]),plan('2026-10-05',[shift('2026-10-09')])];
 const month=calculate('2026-11-09',plans).periods[2];assert.equal(month.current.published_days,7);assert.equal(month.current.total_days,30);assert.equal(month.change,null);
 for(const p of [[],[{employee_id:'e',salary_type:'monthly',salary_rate:40000}],[{employee_id:'e',salary_type:'hourly',salary_rate:null}]]){const r=calculate('2026-11-09',plans,p).periods[0];assert.equal(r.current.missing_rates,1);assert.equal(r.change,null)}
 plans[0].published_snapshot=[shift('2026-11-09',{start_time:'00:00',end_time:'06:00'})];const r=calculate('2026-11-09',plans,people,{}).periods[0];assert.equal(r.current.cost,1200);assert.equal(r.current.missing_rates,1);assert.equal(r.change,null);
});
test('published empty days are zero, missing days are unknown, zero baseline never yields infinity',()=>{
 let r=calculate('2026-11-09',[plan('2026-11-09'),plan('2026-10-05')]).periods[0];assert.equal(r.current.complete,true);assert.equal(r.change,0);assert.equal(r.percent,null);
 r=calculate('2026-11-09',[plan('2026-11-09',[shift('2026-11-09')]),plan('2026-10-05')]).periods[0];assert.equal(r.change,1600);assert.equal(r.percent,null);
 r=calculate('2026-11-09',[]).periods[0];assert.equal(r.current.complete,false);assert.equal(r.change,null);
});
function api({role='admin',active=true,failTable=null}={}){
 let handler;const queries=[];const db={auth:{getUser:async()=>({data:{user:{id:'actor'}}})},from(table){const q={table,filters:[]};queries.push(q);return {select(v){q.columns=v;return this},eq(k,v){q.filters.push([k,v]);return this},gte(){return this},lte(){return this},in(k,v){q.filters.push([k,v]);return this},maybeSingle:async()=>({data:{organization_id:'org',role,active}}),then(resolve,reject){return Promise.resolve({error:table===failTable?{}:null,data:table==='shift_schedules'?[plan('2026-11-09',[shift('2026-11-09')])]:table==='employee_private_details'?people:[]}).then(resolve,reject)}}}};
 vm.runInNewContext(compile('supabase/functions/payroll-dashboard/index.ts'),{Deno:{env:{get:()=>''},serve:f=>handler=f},createClient:()=>db,loadPublishedCosts,Request,Response,console:{error(){}}});
 return {queries,call:(body,auth=true)=>handler(new Request('https://test.invalid',{method:'POST',headers:auth?{Authorization:'Bearer synthetic'}:{},body:JSON.stringify(body)}))};
}
test('API authorizes active ADMIN, derives org server-side and returns only aggregate costs',async()=>{
 const body={action:'published_costs',date:'2026-11-09',organization_id:'forged'};
 assert.equal((await api({role:'employee'}).call(body)).status,403);assert.equal((await api({active:false}).call(body)).status,403);assert.equal((await api().call(body,false)).status,401);
 for(const date of ['2026-02-30','bad','9999-01-01'])assert.equal((await api().call({...body,date})).status,400);
 const f=api(),response=await f.call(body),data=await response.json();assert.equal(response.status,200);assert.equal(data.periods[0].current.cost,1600);assert.equal(data.employees,undefined);assert.equal(data.schedules,undefined);
 for(const q of f.queries.filter(q=>q.table!=='employees'))assert.ok(q.filters.some(([k,v])=>k==='organization_id'&&v==='org'));
 assert.ok(f.queries.every(q=>!['scheduled_shifts','time_entries'].includes(q.table)));
 for(const failTable of ['shift_schedules','employee_private_details','payroll_settings'])assert.equal((await api({failTable}).call(body)).status,503);
});
