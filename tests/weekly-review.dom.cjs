const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window;
 try{
 const errors=[],calls=[],downloads=[];w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});w.confirm=()=>true;
 for(const d of w.document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open')}
 w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download)};
 const summary={work_hours:8,sick_hours:0,evening_hours:0,night_hours:6,weekend_hours:1,overtime_40_hours:0,overtime_100_hours:0,hourly_rate:200,base_cost:1600,premium_cost:162.33,total_cost:1762.33,payroll_codes:{night:{code:'10104',hourly_rate:23.19},weekend:{code:'10106',hourly_rate:23.19}}};
 const employee={employee:{id:'person',full_name:'Test <ansatt>',employee_number:'01'},entries:[{id:'entry',reference_no:42,kind:'work',work_date:'2026-10-04',started_at:'2026-10-04T21:00:00Z',ended_at:'2026-10-05T05:00:00Z',hours:8,source:'location',approved:false}],adjustments:[],shifts:[],summary,unapproved:1,open_entries:0,missing_shifts:0,locked:false};
 let data={week_start:'2026-09-28',week_end:'2026-10-04',fingerprint:'v1',can_lock:true,closes_after:'2026-10-05T06:00:00Z',employees:[employee],locked:false,revisions:[]};
 w.fetch=async(url,options={})=>{const body=JSON.parse(options.body||'{}');calls.push(body);assert.ok(new URL(url).pathname.endsWith('/weekly-review'));if(body.action==='approve'){assert.equal(body.expected,data.fingerprint);employee.entries[0].approved=body.approved;employee.unapproved=body.approved?0:1}if(body.action==='lock_employee'){employee.locked=true}if(body.action==='lock_week'){data.locked=true;data.revision=1;data.lock_id='lock';data.revisions=[{id:'lock',revision:1}]}
 if(body.action==='report')return new Response(JSON.stringify({id:'lock',report:structuredClone(data),revision:1,locked_at:'2026-10-05T06:00:00Z'}));
 data.fingerprint='v'+calls.length;return new Response(JSON.stringify(data));};
 w.eval(fs.readFileSync('app.js','utf8')+'\n'+fs.readFileSync('weekly-review.js','utf8')+`;window.weeklyTest={init:()=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'}},load:loadWeeklyReview,csv:weeklyCsvCell};`);
 await new Promise(r=>setTimeout(r,0));w.weeklyTest.init();w.document.querySelector('#weeklyDate').value='2026-10-01';await w.weeklyTest.load();
 assert.equal(w.document.querySelector('#weeklyDate').value,'2026-09-28');assert.equal(w.document.querySelectorAll('#weeklyPeople button').length,1);
 w.document.querySelector('[data-weekly-person]').click();assert.equal(w.document.querySelectorAll('.weekly-day').length,7);assert.equal(w.document.querySelector('#weeklyEmployeeName ansatt'),null);assert.match(w.document.querySelector('#weeklyDays').textContent,/Avsluttes neste dag/);
 w.document.querySelector('#weeklyLockAll').click();assert.equal(calls.filter(x=>x.action==='lock_week').length,0);
 const input=w.document.querySelector('[data-weekly-approve]');input.checked=true;input.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,25));assert.equal(employee.unapproved,0);
 w.document.querySelector('#weeklyLockEmployee').click();await new Promise(r=>setTimeout(r,25));assert.equal(employee.locked,true);assert.equal(w.document.querySelectorAll('#weeklyPeople button').length,0);assert.match(w.document.querySelector('#weeklyCompleted').textContent,/Test <ansatt>/);
 w.document.querySelector('#weeklyLockAll').click();await new Promise(r=>setTimeout(r,25));assert.equal(data.locked,true);assert.equal(w.document.querySelector('#weeklyReport').classList.contains('hidden'),false);assert.match(w.document.querySelector('#weeklyReportDetails').textContent,/10104/);
 w.document.querySelector('#weeklyExportCsv').click();assert.equal(downloads[0],'apart-ukerapport-2026-09-28-v1.csv');assert.match(w.weeklyTest.csv('=1+1'),/^"'/);assert.equal(errors.length,0);
 console.log('PASS: date/week selection, seven days, overnight text, checkbox save, employee queue, lock gate, report and CSV');
 }finally{w.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
