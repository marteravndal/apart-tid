const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window,$=s=>w.document.querySelector(s);
 try{
  const errors=[],calls=[];let fail=false;
  w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});for(const d of w.document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open')}
  const employee={id:'emp',full_name:'Test Employee',employee_number:'TEST'},shift={id:'custom1',employee_id:'emp',work_date:'2026-11-09',shift_type:'custom',start_time:'22:20',end_time:'06:35'};
  const roster={schedule:{status:'draft'},shifts:[shift,{...shift,id:'custom2'}],employees:[employee],absences:[],payroll_settings:[],attendance:[]};
  w.fetch=async(url,options={})=>{const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};let data={},status=200;
   if(body.action==='save_shift'){calls.push(body);if(fail){status=409;data={error:'Vakten overlapper en annen vakt.'}}else data={id:'new'}}
   else if(path.endsWith('/roster'))data=roster;
   else if(path.endsWith('/roster-insights'))data={employees:[],payroll_settings:[]};
   else if(path.endsWith('/time-review-admin'))data={entries:[]};
   else throw Error('Unexpected endpoint '+path);
   return new Response(JSON.stringify(data),{status});
  };
  w.eval(fs.readFileSync('app.js','utf8')+`;window.testCustom={init:data=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'};rosterData=data;rosterWeekStart='2026-11-09';renderAdminRoster()},open:openRosterShift,premiums:rosterPremiumHours,employee:()=>{rosterData.status='published';employeeRosterWeekStart='2026-11-09';renderEmployeeRoster()}};`);
  await new Promise(r=>setTimeout(r,0));w.testCustom.init(roster);
  assert.equal(w.document.querySelectorAll('.custom-group').length,7);
  for(const group of w.document.querySelectorAll('.custom-group'))assert.equal(group.children.length,2);
  assert.equal($('#rosterWeek').style.getPropertyValue('--custom-shift-height'),'328px');
  $('[data-roster-quick-type="custom"]').click();assert.equal($('#rosterShiftType').value,'custom');assert.equal($('#rosterShiftStart').value,'');assert.equal($('#rosterShiftEnd').value,'');
  $('#rosterShiftEmployee').value='emp';$('#rosterShiftStart').value='22:20';$('#rosterShiftEnd').value='06:35';$('#rosterShiftEnd').oninput();assert.match($('#rosterShiftTimeHint').textContent,/8,25 timer.*neste dag/);
  $('#rosterShiftType').onchange();assert.equal($('#rosterShiftStart').value,'22:20');
  const form=$('#rosterShiftForm'),submit=()=>form.onsubmit({preventDefault(){},target:form,submitter:form.querySelector('button.primary')});
  fail=true;await submit();assert.match($('#rosterShiftError').textContent,/overlapper/);assert.ok($('#rosterShiftDialog').open);assert.equal($('#rosterShiftEnd').value,'06:35');
  fail=false;await submit();assert.equal($('#rosterShiftDialog').open,false);assert.equal(calls.at(-1).shift_type,'custom');assert.equal(calls.at(-1).start_time,'22:20');
  w.testCustom.open(shift.work_date,shift);assert.equal($('#rosterShiftType').value,'custom');assert.equal($('#rosterShiftEnd').value,'06:35');
  $('#rosterShiftEnd').value='22:20';$('#rosterShiftEnd').oninput();assert.equal(form.checkValidity(),false);const before=calls.length;await submit();assert.equal(calls.length,before);
  const premiums=w.testCustom.premiums(shift);assert.equal(premiums.night,6);assert.equal(premiums.evening,100/60);
  w.testCustom.employee();assert.match($('#employeeRosterWeek').textContent,/Egendefinert skift.*22.20–06.35.*neste dag/);
  assert.deepEqual(errors,[]);console.log('Custom shift DOM passed: aligned rows, free times, overnight hint, save/edit, error retention, validation, employee view and premiums.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
