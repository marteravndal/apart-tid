const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window,$=s=>w.document.querySelector(s);
 try{
  w.matchMedia=()=>({matches:false});for(const d of w.document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open')}
  const employee={id:'emp',full_name:'Test Employee',employee_number:'TEST'},legacy={id:'legacy',employee_id:'emp',work_date:'2026-11-11',shift_type:'night',start_time:'00:00:00',end_time:'06:00:00'},newShift={...legacy,id:'new',work_date:'2026-11-12',start_time:'23:45:00'};
  const roster={schedule:{status:'draft'},shifts:[legacy,newShift],employees:[employee],absences:[],payroll_settings:[],attendance:[]},original=JSON.stringify(roster.shifts),calls=[];
  w.fetch=async(url,options={})=>{const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};let data={};
   if(body.action==='save_shift'){calls.push(body);data={id:'saved'}}
   else if(path.endsWith('/roster'))data=roster;
   else if(path.endsWith('/roster-insights'))data={employees:[],payroll_settings:[]};
   else if(path.endsWith('/time-review-admin'))data={entries:[]};
   else throw Error('Unexpected endpoint '+path);
   return new Response(JSON.stringify(data),{status:200});
  };
  w.eval(fs.readFileSync('app.js','utf8')+`;window.testNight={init:data=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'};rosterData=data;rosterWeekStart='2026-11-09';renderAdminRoster()},slot:rosterNightSlot,duration:rosterDuration,open:openRosterShift};`);
  await new Promise(r=>setTimeout(r,0));w.testNight.init(roster);
  assert.equal(w.testNight.slot(legacy),'night2');assert.equal(w.testNight.slot(newShift),'night2');assert.equal(w.testNight.slot({...newShift,start_time:'23:00'}),'night1');
  assert.equal(w.testNight.duration(newShift),6.25);assert.equal(w.testNight.duration(legacy),6);
  assert.ok($('.night2 [data-roster-shift="new"]'));assert.ok($('.night2 [data-roster-shift="legacy"]'));
  $('.night2 [data-roster-quick-date="2026-11-09"]').click();assert.equal($('#rosterShiftStart').value,'23:45');assert.equal($('#rosterShiftEnd').value,'06:00');assert.match($('#rosterShiftTimeHint').textContent,/neste dag/);assert.match($('#rosterShiftHeading').textContent,/Nattskift 2/);
  $('#rosterShiftEmployee').value='emp';const form=$('#rosterShiftForm');await form.onsubmit({target:form,preventDefault(){},submitter:form.querySelector('button.primary')});
  assert.equal(calls.length,1);assert.equal(calls[0].work_date,'2026-11-09');assert.equal(calls[0].start_time,'23:45');assert.equal(calls[0].end_time,'06:00');assert.equal(calls[0].id,undefined);
  w.testNight.open(legacy.work_date,legacy);assert.equal($('#rosterShiftStart').value,'00:00');assert.equal($('#rosterShiftEnd').value,'06:00');assert.match($('#rosterShiftTimeHint').textContent,/samme dag/);assert.equal(JSON.stringify(roster.shifts),original);
  const mobile=fs.readFileSync('admin-app.js','utf8');const label=new Function('rosterMinutes',mobile.match(/function shiftLabel\(shift\)\{[^\n]+/)[0]+';return shiftLabel')(v=>Number(v.slice(0,2))*60+Number(v.slice(3,5)));
  assert.equal(label(newShift),'Nattskift 2');assert.equal(label(legacy),'Nattskift 2');assert.equal(label({...newShift,start_time:'23:00'}),'Nattskift 1');
  console.log('Night presets passed: new 23:45–06:00, next-day end, unchanged legacy shifts, aligned rows, and mobile labels.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
