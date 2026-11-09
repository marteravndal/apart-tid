const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test'),{stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync('supabase/functions/roster/index.ts','utf8').replace(/^import .*;\n/gm,''));
function api(options={}){
 let handler;const writes=[];
 const me={id:options.role==='employee'?'employee':'admin',organization_id:'org',role:options.role||'admin',active:true};
 const shift={id:'existing',employee_id:'employee',work_date:'2026-11-09',shift_type:'custom',start_time:'09:15',end_time:'14:45'};
 const client={auth:{getUser:async()=>({data:{user:{id:'auth'}},error:null})},from(table){
  const q={table,filters:[],op:'read',payload:null};
  for(const method of ['select','order','limit'])q[method]=()=>q;
  for(const method of ['eq','neq','lte','gte'])q[method]=(key,value)=>{q.filters.push([key,value]);return q};
  for(const method of ['insert','update','delete'])q[method]=payload=>{q.op=method;q.payload=payload;writes.push({table,op:method,payload});return q};
  function result(){
   if(q.op!=='read')return {data:{id:'saved'},error:null};
   let data;
   if(table==='employees')data=q.filters.some(([k])=>k==='auth_user_id')?me:{id:'employee',full_name:'Test Employee'};
   else if(table==='shift_schedules')data={id:'schedule',status:'published',published_snapshot:[shift,{...shift,id:'other',employee_id:'other'}]};
   else if(table==='scheduled_shifts')data=q.filters.some(([k])=>k==='id')?shift:(options.overlap?[shift]:[]);
   else if(table==='sick_leave_requests')data=options.sick?{id:'sick'}:null;
   else if(table==='vacation_requests')data=options.vacation?{id:'vacation',request_type:'vacation'}:null;
   else throw Error('Unexpected table '+table);
   return {data,error:null};
  }
  q.single=q.maybeSingle=async()=>result();q.then=(resolve,reject)=>Promise.resolve(result()).then(resolve,reject);return q;
 }};
 vm.runInNewContext(source,{Deno:{serve:fn=>handler=fn,env:{get:()=>''}},createClient:()=>client,Response,URL,Request,console,fetch:()=>{throw Error('No email allowed in tests')}});
 return {writes,call:async(body={},method='POST')=>{const response=await handler(new Request('https://test.invalid/roster?week=2026-11-09',{method,headers:{Authorization:'Bearer test','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({action:'save_shift',employee_id:'employee',work_date:'2026-11-09',shift_type:'custom',start_time:'09:15',end_time:'14:45',...body})})}));return {status:response.status,body:await response.json()}}};
}
test('custom shift accepts arbitrary minutes, preserves exact times and audit details',async()=>{const a=api(),r=await a.call();assert.equal(r.status,201);const saved=a.writes.find(w=>w.table==='scheduled_shifts').payload;assert.equal(saved.shift_type,'custom');assert.equal(saved.start_time,'09:15');assert.equal(saved.end_time,'14:45');assert.equal(a.writes.find(w=>w.table==='audit_logs').payload.details.after.shift_type,'custom')});
test('custom shift accepts crossing midnight and updates same shift',async()=>{const a=api();assert.equal((await a.call({id:'existing',start_time:'22:20',end_time:'06:35'})).status,200);assert.equal(a.writes.find(w=>w.table==='scheduled_shifts').op,'update')});
test('custom shifts retain overlap and absence checks',async()=>{for(const opt of [{overlap:true},{sick:true},{vacation:true}]){const a=api(opt),r=await a.call();assert.equal(r.status,409);assert.equal(a.writes.filter(w=>w.table==='scheduled_shifts').length,0)}});
test('equal, invalid or unsupported times/types cannot be saved',async()=>{for(const body of [{end_time:'09:15'},{start_time:'25:00'},{shift_type:'unknown'}]){const a=api(),r=await a.call(body);assert.equal(r.status,400);assert.equal(a.writes.length,0)}});
test('standard shift times can still be customized',async()=>{assert.equal((await api().call({shift_type:'night',start_time:'22:20',end_time:'06:35'})).status,201)});
test('employees cannot save shifts and only receive their published shifts',async()=>{const a=api({role:'employee'});assert.equal((await a.call()).status,403);const r=await a.call({},'GET');assert.equal(r.status,200);assert.equal(r.body.shifts.length,1);assert.equal(r.body.shifts[0].shift_type,'custom')});
