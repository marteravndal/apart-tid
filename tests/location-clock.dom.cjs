// Run with Node 24 and jsdom 26.1.0 available in NODE_PATH.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {fixture}=require('./location-clock-fixture.cjs');
(async()=>{
 const f=fixture(),dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/?qr=legacy-poster',runScripts:'outside-only'}),w=dom.window;
 try{
  let postCount=0,geoMode='ok';const errors=[];
  w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});
  w.localStorage.setItem('apart-tid-session',JSON.stringify({access_token:'synthetic-test',expires_at:Date.now()/1000+3600,user:{id:'test-user'}}));
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(resolve,reject)=>geoMode==='denied'?reject({code:1}):resolve({coords:{latitude:59,longitude:geoMode==='outside'?7:6,accuracy:geoMode==='inaccurate'?250:10},timestamp:Date.now()})}});
  w.fetch=async(url,options={})=>{
   const path=new URL(url).pathname;let body={},status=200;
   if(path==='/rest/v1/employees')body=[{...f.employee,employee_number:'TEST',email:'test@example.invalid'}];
   else if(path==='/functions/v1/employee-admin'){body={employee:{full_name:'Test Ansatt'},entries:[{id:'e1',started_at:'2026-10-06T14:00:00Z',ended_at:'2026-10-06T21:00:42Z',source:'location'},{id:'e2',started_at:'2026-10-06T21:01:36Z',ended_at:null,source:'location'}],events:[]}}
   else if(path==='/functions/v1/employee-home')body={documents:[],notifications:{}};
   else if(path==='/functions/v1/time-clock'){const method=options.method||'GET';if(method==='POST')postCount++;const result=await f.call(options.body?JSON.parse(options.body):null,method);body=result.body;status=result.status}
   else throw Error('Unexpected endpoint '+path);
   return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  };
  w.eval(fs.readFileSync('app.js','utf8')+`;window.testClock={setGate:gate=>{clockState.open_entry=null;clockState.clock_in_gate=gate;renderClock()},setEmployees:items=>{employees=items;renderEmployees()},openLog:openClockLog};`);
  for(let i=0;i<100&&w.document.querySelector('#scanClock').disabled;i++)await new Promise(r=>setTimeout(r,10));
  const button=w.document.querySelector('#scanClock'),message=w.document.querySelector('#clockMessage');
  assert.equal(w.location.search,'');assert.equal(postCount,0);assert.equal(button.disabled,false);assert.equal(button.textContent,'Stemple inn');
  geoMode='denied';await button.onclick();assert.match(message.textContent,/ikke registrert.*blokkert/);assert.equal(postCount,0);assert.equal(button.disabled,false);
  geoMode='outside';await button.onclick();assert.match(message.textContent,/ikke registrert.*arbeidsstedet/);assert.equal(f.writes.length,0);
  geoMode='inaccurate';await button.onclick();assert.match(message.textContent,/ikke registrert.*unøyaktig/);assert.equal(f.writes.length,0);
  geoMode='ok';const first=button.onclick();await button.onclick();await first;
  assert.match(message.textContent,/Du er stemplet inn kl/);assert.equal(button.textContent,'Stemple ut');assert.equal(f.writes.filter(x=>x.table==='time_entries'&&x.kind==='insert').length,1);
  await button.onclick();assert.match(message.textContent,/Du er stemplet ut kl/);assert.equal(button.textContent,'Stemple inn');
  const before=f.writes.length;await w.document.querySelector('#testWorksitePosition').onclick();assert.match(w.document.querySelector('#positionTestResult').textContent,/Posisjonen er godkjent/);assert.equal(f.writes.length,before);
  // A stale page must refresh its intent, never reverse an action on another device.
  await f.call({action:'clock_in',latitude:59,longitude:6,accuracy:10,position_timestamp:Date.now()});
  const postsBefore=postCount;await button.onclick();assert.equal(postCount,postsBefore);assert.equal(button.textContent,'Stemple ut');assert.match(message.textContent,/statusen er oppdatert/);
  w.testClock.setGate({allowed:false,code:'cooldown',message:'Vent',available_at:new Date(Date.now()+119000).toISOString()});
  assert.equal(button.disabled,true);assert.match(w.document.querySelector('#clockGateHint').textContent,/1:59/);
  w.testClock.setEmployees([{id:'test-employee',full_name:'Test Ansatt',employee_number:'TEST',email:'test@example.invalid',role:'employee',active:true,invited_at:null,open_entry:{id:'e2',started_at:'2026-10-06T21:01:36Z'}}]);
  assert.equal(w.document.querySelector('[data-clock]').textContent,'Stemple ut');
  assert.ok(w.document.querySelector('[data-clock-log]'));
  w.document.querySelector('#clockLogDialog').showModal=()=>{};
  await w.testClock.openLog('test-employee');
  assert.match(w.document.querySelector('#clockLogRows').textContent,/under 2 minutter/);
  assert.match(w.document.querySelector('#clockLogRows').textContent,/23:01:36/);
  assert.deepEqual(errors,[]);
  console.log('DOM/API integration passed: full app loads, no automatic QR stamp, permission denied, outside area, poor accuracy, duplicate click, in/out, stale status, non-stamping position test. Synthetic data only.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
