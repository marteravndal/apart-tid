const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync('supabase/functions/time-clock/index.ts','utf8').replace(/^import .*;\n/gm,'');
const compiled=stripTypeScriptTypes(source);
function fixture(options={}) {
  let handler; const writes=[],queries=[];
  const employee={id:'employee-test',organization_id:'org-test',role:options.role||'employee',active:options.active!==false};
  const worksite={id:'site-test',name:'Teststed',address:'Testadresse',latitude:59,longitude:6,radius_meters:100};
  const db={auth:{getUser:async()=>({data:{user:options.unauthenticated?null:{id:'user-test'}}})},
    rpc:async(name,args)=>{assert.equal(name,'verify_qr_reserve');assert.equal(args.p_employee_id,employee.id);return options.rpcError?{error:{message:'db offline'}}:{data:{status:options.reserveStatus||'valid',id:'qr-test',location_check_required:true,retry_after:900}}},
    from(table){const q={table,kind:'read',values:null,filters:[]};queries.push(q);const builder={};
      for(const method of ['select','eq','is','lte','gt','gte','order','limit'])builder[method]=(...args)=>{q.filters.push([method,...args]);return builder};
      for(const method of ['insert','update'])builder[method]=values=>{q.kind=method;q.values=values;writes.push(q);return builder};
      const result=()=>{if(table==='employees')return{data:employee};if(table==='worksites')return{data:worksite};if(table==='qr_codes')return{data:q.kind==='insert'?{reserve_code:'01234567'}:options.missingQr?null:{id:'qr-test',location_check_required:true,reserve_code:'01234567'}};if(table==='time_entries')return{data:q.kind==='read'?options.openEntry||null:{id:'entry-test',started_at:'2026-10-05T06:00:00Z',ended_at:null}};return{data:[]}};
      builder.single=async()=>result();builder.maybeSingle=async()=>result();builder.then=(resolve,reject)=>Promise.resolve(result()).then(resolve,reject);return builder;
    }};
  vm.runInNewContext(compiled,{Deno:{env:{get:()=> 'test'},serve:fn=>{handler=fn}},createClient:()=>db,QRCode:{toString:async()=>'<svg width="420" height="420" viewBox="0 0 20 20"></svg>'},crypto:globalThis.crypto,TextEncoder,Request,Response,URL,console,btoa});
  async function call(body,method='POST',auth=true){const response=await handler(new Request('https://test.invalid/time-clock',{method,headers:{...(auth?{Authorization:'Bearer test'}:{}),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}));return{status:response.status,body:await response.json()}}
  return{call,writes,queries};
}
const valid={action:'clock_in',reserve_code:'0123 4567',latitude:59,longitude:6,accuracy:10};
test('reserve code clocks in through normal path and does not leak code',async()=>{const f=fixture(),r=await f.call(valid);assert.equal(r.status,201);assert.equal(f.writes.find(q=>q.table==='time_entries').values.source,'qr');assert.ok(!JSON.stringify(r.body).includes('01234567'));assert.ok(!JSON.stringify(f.writes).includes('01234567'))});
test('reserve code clocks out',async()=>{const f=fixture({openEntry:{id:'open-test'}}),r=await f.call({...valid,action:'clock_out'});assert.equal(r.status,200);assert.equal(f.writes.find(q=>q.table==='time_entries').kind,'update')});
test('authentication and active account are mandatory',async()=>{assert.equal((await fixture().call(valid,'POST',false)).status,401);assert.equal((await fixture({unauthenticated:true}).call(valid)).status,401);assert.equal((await fixture({active:false}).call(valid)).status,403)});
test('invalid, expired or revoked reserve returns no write',async()=>{const f=fixture({reserveStatus:'invalid'});assert.equal((await f.call(valid)).status,403);assert.equal(f.writes.length,0)});
test('rate limit and database errors fail closed',async()=>{assert.equal((await fixture({reserveStatus:'limited'}).call(valid)).status,429);assert.equal((await fixture({rpcError:true}).call(valid)).status,503)});
test('format and location are validated',async()=>{for(const bad of [{reserve_code:'123'},{latitude:null},{latitude:91},{accuracy:150},{longitude:7}]){const f=fixture(),r=await f.call({...valid,...bad});assert.ok([400,403].includes(r.status));assert.equal(f.writes.length,0)}});
test('original QR token still works',async()=>{const r=await fixture().call({...valid,reserve_code:undefined,qr_token:'original-long-token'});assert.equal(r.status,201)});
test('only ADMIN gets reserve code in status',async()=>{const employee=await fixture().call(null,'GET');assert.equal(employee.body.qr_status,null);assert.ok(!JSON.stringify(employee.body).includes('01234567'));const admin=await fixture({role:'admin'}).call(null,'GET');assert.equal(admin.body.qr_status.reserve_code,'01234567')});
test('new QR download contains its reserve code',async()=>{const r=await fixture({role:'admin'}).call({action:'issue_qr',base_url:'https://tid.apartstavanger.no'});assert.equal(r.status,201);assert.match(r.body.qr_svg,/0123 4567/);assert.equal(r.body.reserve_code,'01234567')});
test('employee cannot issue or revoke QR',async()=>{assert.equal((await fixture().call({action:'issue_qr'})).status,403);assert.equal((await fixture().call({action:'revoke_qr'})).status,403)});
test('HTML ids are unique and reserve form is wired',()=>{const html=fs.readFileSync('index.html','utf8'),js=fs.readFileSync('app.js','utf8'),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);for(const id of ['openReserveClock','reserveClockForm','reserveClockInput','reserveClockError','qrReserveCode','printReserveCode']){assert.ok(ids.includes(id));assert.ok(js.includes('#'+id))}});
test('frontend uses reserve request, preserves leading zeroes and shows errors in dialog',async()=>{const js=fs.readFileSync('app.js','utf8'),code=js.split('\n').filter(l=>l.startsWith('async function clockWithQr(')||l.startsWith('function formatReserveCode(')).join('\n'),elements=new Map();let sent;
  const context={$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)},normalizeQrToken:x=>String(x).trim(),clockState:{},getPosition:async()=>({coords:{latitude:59,longitude:6,accuracy:10}}),authenticated:async(path,request)=>{sent=request.body;return{entry:{started_at:'2026-10-05T06:00:00Z'}}},show:()=>{},formatTime:()=>'',loadClock:async()=>{},renderClock:()=>{}};
  vm.createContext(context);vm.runInContext(code,context);assert.equal(vm.runInContext("formatReserveCode('01234567')",context),'0123 4567');assert.equal(await vm.runInContext("clockWithQr('01234567',true)",context),true);assert.equal(sent.reserve_code,'01234567');assert.equal(sent.qr_token,undefined);
  context.authenticated=async()=>{throw Error('Testfeil')};assert.equal(await vm.runInContext("clockWithQr('01234567',true)",context),false);assert.equal(elements.get('#reserveClockError').textContent,'Testfeil');assert.equal(elements.get('#openReserveClock').disabled,false);
});
