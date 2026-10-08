const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const compiled=stripTypeScriptTypes(fs.readFileSync('supabase/functions/time-review-admin/index.ts','utf8').replace(/^import .*;\n/gm,''));
const emp='10000000-0000-0000-0000-000000000001',id='20000000-0000-0000-0000-000000000001';
const entry={id,employee_id:emp,reference_no:42,started_at:'2026-10-06T21:01:36Z',ended_at:'2026-10-07T05:41:00Z',source:'qr'};
function fixture(options={}){
 let handler;const queries=[],rpcs=[];
 const db={auth:{getUser:async()=>({data:{user:options.noAuth?null:{id:'admin-user'}}})},rpc:async(name,args)=>{rpcs.push({name,args});return options.rpcError?{error:{message:options.rpcError}}:{data:{ok:true,reference_no:42}}},from(table){
  const q={table,filters:[]};queries.push(q);const b={};
  for(const m of ['select','eq','is','in','gte','lt','not','order','limit','range'])b[m]=(...args)=>{q.filters.push([m,...args]);return b};
  const get=()=>{
   if(table==='employees'){
    if(q.filters.some(x=>x[1]==='auth_user_id'))return{data:{id:'admin-employee',organization_id:'org',role:options.role||'admin',active:!options.inactive}};
    return{data:[{id:emp,full_name:'Test Employee',employee_number:'TEST',auth_user_id:'employee-user'},{id:'admin-employee',full_name:'Test Admin',auth_user_id:'admin-user'}]};
   }
   if(table==='month_locks')return{data:q.filters.some(x=>x[0]==='eq'&&x[1]==='month_start')?null:options.locked?[{month_start:'2026-10-01'}]:[],error:options.lockError?{message:'offline'}:null};
   if(table==='month_approvals'||table==='weekly_employee_locks'||table==='weekly_period_locks')return{data:[]};
   if(table==='time_entries')return{data:[{...entry,scheduled_shift_id:id}]};
   if(table==='clock_register')return{data:options.many?Array.from({length:51},(_,i)=>({...entry,id:'entry-'+i})):[{...entry,...options.entry}],error:options.readError?{message:'offline'}:null};
   if(table==='audit_logs')return{data:[{entity_id:id,action:'delete_time_entry',actor_id:'admin-user',created_at:'2026-10-07T06:00:00Z',details:{reason:'Mistake',before:{started_at:entry.started_at,ended_at:entry.ended_at,clock_in_latitude:59},private_secret:'not-for-client'}}]};
   throw Error('Unexpected query '+table);
  };b.single=async()=>get();b.maybeSingle=async()=>get();b.then=(resolve,reject)=>Promise.resolve(get()).then(resolve,reject);return b;
 }};
 vm.runInNewContext(compiled,{Deno:{env:{get:()=> 'test'},serve:fn=>handler=fn},createClient:()=>db,Response,Request,console,URL});
 return{queries,rpcs,call:async(body,auth=true)=>{const r=await handler(new Request('https://test.invalid/',{method:'POST',headers:auth?{Authorization:'Bearer test'}:{},body:JSON.stringify(body)}));return{status:r.status,body:await r.json()}}};
}
const filter={action:'register',month:'2026-10',page:0,status:'all'};
test('register requires active ADMIN and scopes every data query to their org',async()=>{
 for(const options of [{role:'employee'},{inactive:true},{noAuth:true}])assert.ok([401,403].includes((await fixture(options).call(filter)).status));
 const f=fixture(),r=await f.call(filter);assert.equal(r.status,200);for(const q of f.queries.filter(q=>!q.filters.some(x=>x[1]==='auth_user_id')))assert.ok(q.filters.some(x=>x[1]==='organization_id'&&x[2]==='org'),q.table);
 assert.equal(r.body.events[0].actor,'Test Admin');assert.ok(!JSON.stringify(r.body).includes('private_secret'));assert.ok(!JSON.stringify(r.body.events).includes('latitude'));assert.ok(!JSON.stringify(r.body.employees).includes('auth_user_id'));
});
test('month boundaries use Oslo and paging has no silent cap',async()=>{const f=fixture({many:true}),r=await f.call({...filter,page:2});assert.equal(r.body.entries.length,50);assert.equal(r.body.has_more,true);const q=f.queries.find(x=>x.table==='clock_register');assert.ok(q.filters.some(x=>x[0]==='gte'&&x[2]==='2026-09-30T22:00:00.000Z'));assert.ok(q.filters.some(x=>x[0]==='lt'&&x[2]==='2026-10-31T23:00:00.000Z'));assert.ok(q.filters.some(x=>x[0]==='range'&&x[1]===100&&x[2]===150))});
test('reference lookup spans months, deleted filter and locked flags work',async()=>{const f=fixture({locked:true,entry:{deleted_at:'2026-10-07T06:00:00Z',deleted_by:'admin-user'}}),r=await f.call({...filter,reference:'ST-000042',status:'deleted'});const q=f.queries.find(x=>x.table==='clock_register');assert.ok(q.filters.some(x=>x[1]==='reference_no'&&x[2]===42));assert.ok(!q.filters.some(x=>x[0]==='gte'));assert.ok(q.filters.some(x=>x[0]==='not'&&x[1]==='deleted_at'));assert.equal(r.body.entries[0].locked,true);assert.equal(r.body.entries[0].deleted_by_name,'Test Admin')});
test('invalid/foreign filters and database failures fail closed',async()=>{for(const patch of [{month:'wrong'},{page:-1},{reference:'ST-x'},{status:'unknown'},{employee_id:'30000000-0000-0000-0000-000000000001'}])assert.ok([400,404].includes((await fixture().call({...filter,...patch})).status));for(const options of [{readError:true},{lockError:true}])assert.equal((await fixture(options).call(filter)).status,503)});
const deletion={action:'delete',entry_id:id,started_at:entry.started_at,ended_at:entry.ended_at,reason:'Mistaken re-entry'};
test('deletion is a single atomic RPC with authenticated actor and org',async()=>{const f=fixture(),r=await f.call({...deletion,actor_id:'forged',organization_id:'foreign'});assert.equal(r.status,200);assert.equal(f.rpcs.length,1);assert.equal(f.rpcs[0].name,'delete_clock_entry');assert.equal(f.rpcs[0].args.p_actor_id,'admin-user');assert.equal(f.rpcs[0].args.p_organization_id,'org');assert.equal(f.rpcs[0].args.p_ended_at,entry.ended_at)});
test('invalid deletion does not call RPC; DB rejection is shown as conflict',async()=>{for(const patch of [{reason:' '},{ended_at:null},{entry_id:''}]){const f=fixture();assert.equal((await f.call({...deletion,...patch})).status,400);assert.equal(f.rpcs.length,0)}const f=fixture({rpcError:'Måneden er låst og kan ikke endres.'});assert.equal((await f.call(deletion)).status,409)});
const stamp={action:'stamp_shift',shift_id:id,expected:{employee_id:emp,work_date:'2026-10-06',start_time:'23:00',end_time:'07:00'},started_at:entry.started_at,ended_at:entry.ended_at,kind:'sick_pay',reason:'Employee forgot to record absence'};
test('roster stamping uses authenticated ADMIN actor and atomic RPC with chosen kind',async()=>{const f=fixture(),r=await f.call({...stamp,actor_id:'forged',organization_id:'foreign'});assert.equal(r.status,201);assert.equal(f.rpcs[0].name,'stamp_roster_shift');assert.equal(f.rpcs[0].args.p_actor_id,'admin-user');assert.equal(f.rpcs[0].args.p_organization_id,'org');assert.equal(f.rpcs[0].args.p_kind,'sick_pay');assert.equal(f.rpcs[0].args.p_expected.employee_id,emp)});
test('roster stamping rejects invalid inputs and surfaces duplicate conflicts',async()=>{for(const patch of [{kind:'bonus'},{reason:' '},{expected:null},{ended_at:null},{shift_id:''}]){const f=fixture();assert.equal((await f.call({...stamp,...patch})).status,400);assert.equal(f.rpcs.length,0)}assert.equal((await fixture({role:'employee'}).call(stamp)).status,403);assert.equal((await fixture({rpcError:'Vakten er allerede etterregistrert.'}).call(stamp)).status,409)});
test('roster attendance status is organization scoped and validates IDs',async()=>{const f=fixture(),r=await f.call({action:'roster_attendance',shift_ids:[id]});assert.equal(r.status,200);assert.equal(r.body.entries[0].scheduled_shift_id,id);assert.ok(f.queries.find(q=>q.table==='time_entries').filters.some(x=>x[1]==='organization_id'&&x[2]==='org'));assert.equal((await fixture().call({action:'roster_attendance',shift_ids:['wrong']})).status,400)});
