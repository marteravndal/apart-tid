const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const compiled=stripTypeScriptTypes(fs.readFileSync('supabase/functions/employee-admin/index.ts','utf8').replace(/^import .*;\n/gm,''));
function fixture(options={}){
 let handler;const writes=[],queries=[];
 const actor={id:'admin-employee',organization_id:'test-org',role:options.role||'admin',active:true};
 const target={id:'target',active:options.active!==false,full_name:'Test Ansatt',invited_at:null};
 const db={auth:{getUser:async()=>({data:{user:{id:'admin-user',email:'admin@example.invalid'}}})},from(table){
  const q={table,kind:'read',filters:[]};queries.push(q);const b={};
  for(const m of ['select','eq','is','in','gte','order','limit'])b[m]=(...args)=>{q.filters.push([m,...args]);return b};
  for(const m of ['insert','update'])b[m]=values=>{q.kind=m;q.values=values;writes.push(q);return b};
  const get=()=>{
   if(table==='employees'){
    if(q.filters.some(x=>x[0]==='in'))return{data:[{auth_user_id:'admin-user',full_name:'Test Admin'}]};
    if(q.filters.some(x=>x[1]==='auth_user_id'))return{data:actor};
    assert.ok(q.filters.some(x=>x[1]==='organization_id'&&x[2]==='test-org'));
    return{data:options.foreignEmployee?null:target};
   }
   if(table==='daily_reports')return{data:null};
   if(table==='time_entries'){
    if(q.kind==='update')return{data:options.race?null:{id:'open-entry',started_at:'2026-10-06T21:01:36Z',ended_at:q.values.ended_at}};
    if(q.filters.some(x=>x[0]==='is'))return{data:{id:'open-entry',started_at:'2026-10-06T21:01:36Z',ended_at:null,note:null}};
    return{data:[{id:'open-entry',started_at:'2026-10-06T21:01:36Z',ended_at:null,source:'qr'}]};
   }
   if(table==='audit_logs'&&q.kind==='read')return{data:[{id:1,actor_id:'admin-user',action:'manual_clock_out',created_at:'2026-10-07T05:00:00Z',entity_id:'open-entry',details:{reason:'Test reason',distance_meters:42}}]};
   return{data:[]};
  };
  b.single=async()=>get();b.maybeSingle=async()=>get();b.then=(resolve,reject)=>Promise.resolve(get()).then(resolve,reject);return b;
 }};
 vm.runInNewContext(compiled,{Deno:{env:{get:()=> 'test'},serve:fn=>handler=fn},createClient:()=>db,Response,Request,console,URL,TextEncoder});
 return{writes,queries,call:async body=>{const r=await handler(new Request('https://test.invalid/',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify(body)}));return{status:r.status,body:await r.json()}}};
}
test('clock log is admin-only and scoped to their organization',async()=>{assert.equal((await fixture({role:'employee'}).call({action:'clock_log',employee_id:'target'})).status,403);assert.equal((await fixture({foreignEmployee:true}).call({action:'clock_log',employee_id:'target'})).status,404);const f=fixture(),r=await f.call({action:'clock_log',employee_id:'target',days:30});assert.equal(r.status,200);assert.equal(r.body.events[0].actor,'Test Admin');assert.ok(!JSON.stringify(r.body).includes('distance_meters'));assert.equal(f.writes.length,0)});
test('manual clock-out works even if employee invitation failed or account is inactive',async()=>{for(const active of [true,false]){const f=fixture({active}),r=await f.call({action:'manual_clock',employee_id:'target',clock_action:'clock_out',open_entry_id:'open-entry',reason:'Test reason'});assert.equal(r.status,200);const write=f.writes.find(x=>x.table==='time_entries');assert.ok(write.filters.some(x=>x[0]==='is'&&x[1]==='ended_at'));const log=f.writes.find(x=>x.table==='audit_logs').values;assert.equal(log.actor_id,'admin-user');assert.equal(log.details.reason,'Test reason');assert.equal(log.details.before.ended_at,null)}});
test('manual clock-out requires reason and the same open entry',async()=>{for(const patch of [{reason:''},{open_entry_id:'stale'}]){const f=fixture(),r=await f.call({action:'manual_clock',employee_id:'target',clock_action:'clock_out',open_entry_id:'open-entry',reason:'Test reason',...patch});assert.ok([400,409].includes(r.status));assert.equal(f.writes.length,0)}});
test('concurrent manual clock-out does not record a false success',async()=>{const f=fixture({race:true}),r=await f.call({action:'manual_clock',employee_id:'target',clock_action:'clock_out',open_entry_id:'open-entry',reason:'Test reason'});assert.equal(r.status,409);assert.equal(f.writes.filter(x=>x.table==='audit_logs').length,0)});
