const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window;
 try{
  const errors=[],calls=[];let registered=null,reject=false;
  w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});for(const d of w.document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open')}
  const employee={id:'emp',full_name:'Test Ansatt',employee_number:'TEST'},shift={id:'shift',employee_id:'emp',work_date:'2025-06-02',shift_type:'night',start_time:'23:00:00',end_time:'07:00:00'};
  const roster={schedule:{status:'draft'},shifts:[shift],employees:[employee],absences:[],payroll_settings:[],attendance:[]};
  w.fetch=async(url,options={})=>{const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};calls.push({path,body});let data={},status=200;
   if(path.endsWith('/roster'))data=roster;
   else if(path.endsWith('/roster-insights'))data={employees:[],payroll_settings:[]};
   else if(path.endsWith('/time-review-admin')){
    if(body.action==='roster_attendance')data={entries:registered?[registered]:[]};
    if(body.action==='stamp_shift'){if(reject){status=409;data={error:'Tidene overlapper en registrering.'}}else{registered={id:'entry',reference_no:99,scheduled_shift_id:'shift',kind:body.kind,started_at:body.started_at,ended_at:body.ended_at};data={entry:registered}}}
   }else throw Error('Unexpected endpoint '+path);
   return new Response(JSON.stringify(data),{status});
  };
  w.eval(fs.readFileSync('app.js','utf8')+`;window.testBackfill={init:data=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'};rosterData=data;rosterWeekStart='2025-06-02';renderAdminRoster()},report:renderSummaryReport};`);
  await new Promise(r=>setTimeout(r,0));w.testBackfill.init(roster);
  w.document.querySelector('[data-roster-stamp]').click();assert.ok(w.document.querySelector('#stampShiftDialog').open);assert.equal(w.document.querySelector('#stampShiftStart').value,'2025-06-02T23:00');assert.equal(w.document.querySelector('#stampShiftEnd').value,'2025-06-03T07:00');
  w.document.querySelector('#cancelStampShift').click();assert.equal(calls.filter(x=>x.body.action==='stamp_shift').length,0);
  w.document.querySelector('[data-roster-stamp]').click();w.document.querySelector('#stampShiftEnd').value='2025-06-03T07:30';w.document.querySelector('#stampShiftKind').value='sick_pay';w.document.querySelector('#stampShiftKind').onchange();assert.match(w.document.querySelector('#stampShiftHint').textContent,/8,5 t.*Ingen kvelds-, natt- eller helgetillegg/);
  const form=w.document.querySelector('#stampShiftForm');await form.onsubmit({preventDefault(){}});assert.equal(calls.filter(x=>x.body.action==='stamp_shift').length,0);
  w.document.querySelector('#stampShiftReason').value='Test illness';reject=true;await form.onsubmit({preventDefault(){}});assert.match(w.document.querySelector('#stampShiftError').textContent,/overlapper/);
  reject=false;const action=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});await action;assert.equal(calls.filter(x=>x.body.action==='stamp_shift').length,2);assert.equal(w.document.querySelector('#stampShiftDialog').open,false);assert.equal(w.document.querySelector('[data-roster-stamp]'),null);assert.match(w.document.querySelector('.roster-stamped').textContent,/Sykepenger · ST-000099/);
  const request=calls.filter(x=>x.body.action==='stamp_shift').at(-1).body;assert.equal(request.started_at,'2025-06-02T21:00:00.000Z');assert.equal(request.ended_at,'2025-06-03T05:30:00.000Z');assert.equal(request.kind,'sick_pay');assert.equal(request.expected.employee_id,'emp');
  w.testBackfill.report({from:'2025-06-01',to:'2025-06-30',employees:[employee,{id:'sick',full_name:'Test Sick',employee_number:'SICK'}],entries:[{employee_id:'emp',kind:'work',started_at:'2025-06-02T19:00Z',ended_at:'2025-06-03T05:00Z',source:'manual',premium_hours:{evening:3,night:6}},{employee_id:'sick',kind:'sick_pay',started_at:'2025-06-02T19:00Z',ended_at:'2025-06-03T05:00Z',source:'manual',premium_hours:{evening:999,night:999}}],adjustments:[]});
  const rows=w.document.querySelectorAll('#summaryReportRows tr');assert.equal(rows[0].children[2].textContent,'3 t');assert.equal(rows[0].children[3].textContent,'6 t');assert.equal(rows[1].children[2].textContent,'0 t');assert.equal(rows[1].children[3].textContent,'0 t');assert.equal(rows[1].children[6].textContent,'10 t');assert.equal(w.document.querySelector('#summaryReportTotal tr').children[3].textContent,'6 t');
  assert.deepEqual(errors,[]);console.log('Roster DOM passed: prefilled overnight dates, edited hours, sickness explanation, cancel, missing reason, conflict, duplicate submit, reference/status and report totals.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
