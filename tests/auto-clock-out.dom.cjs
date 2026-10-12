const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window;
 try{
 const errors=[];w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});
 const entry={id:'test',employee_id:'test-person',employee_name:'Test Person',employee_number:'TEST',reference_no:123,kind:'work',started_at:'2026-10-10T18:00:00Z',ended_at:'2026-10-11T06:00:00Z',auto_clocked_out:true,source:'location',auto_notifications:[{recipient:'employee',status:'pending'},{recipient:'admin',status:'sent'}]};
 const event={entry_id:entry.id,action:'auto_clock_out',actor:'System',at:entry.ended_at,reason:'Automatisk utstemplet etter 12 timer.'};
 w.fetch=async(url)=>{const path=new URL(url).pathname;const body=path.endsWith('/employee-admin')?{employee:{full_name:'Test Person'},entries:[entry],events:[event]}:path.endsWith('/time-review-admin')?{entries:[entry],events:[event],employees:[{id:'test-person',employee_number:'TEST',full_name:'Test Person'}],page:0,has_more:false}:null;assert.ok(body,'Unexpected endpoint');return new Response(JSON.stringify(body))};
 w.eval(fs.readFileSync('app.js','utf8')+`;window.autoTest={init:()=>saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600}),employee:e=>{clockState={entries:[e],adjustments:[],approvals:[],open_entry:null,worksite:{address:'Test',radius_meters:100},clock_in_gate:{allowed:false,message:'Test'}};$('#periodMonth').value='2026-10';renderClock()},log:()=>{activeClockLogId='test-person';return loadClockLog()},register:()=>loadStamping(0)};`);
 await new Promise(r=>setTimeout(r,0));w.autoTest.init();w.autoTest.employee(entry);
 assert.equal(w.document.querySelector('#timeRows .auto-clock-badge').textContent,'Automatisk utstemplet');assert.equal(w.document.querySelector('#timeRows').textContent.includes('12 t'),true);
 w.autoTest.employee({...entry,ended_at:'2026-10-11T02:00:00Z',source:'manual'});assert.equal(w.document.querySelector('#timeRows .auto-clock-badge').textContent,'Automatisk utstemplet');assert.match(w.document.querySelector('#timeRows').textContent,/8 t/);
 await w.autoTest.log();assert.match(w.document.querySelector('#clockLogRows').textContent,/Automatisk utstemplet/);assert.match(w.document.querySelector('#clockLogEvents').textContent,/Automatisk utstemplet/);
 await w.autoTest.register();assert.equal(w.document.querySelector('#stampingRows .auto-clock-badge').textContent,'Automatisk utstemplet');assert.match(w.document.querySelector('#stampingRows .stamp-history').textContent,/Automatisk utstemplet/);
 assert.match(w.document.querySelector('#stampingRows').textContent,/Ansatt: venter på sending/);assert.match(w.document.querySelector('#stampingRows').textContent,/ADMIN: sendt/);assert.deepEqual(errors,[]);console.log('PASS: employee badge, corrected time preserves badge, ADMIN log and general register.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
