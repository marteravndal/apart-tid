const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window;
 try{
  const calls=[],downloads=[],errors=[];let fail=false;
  w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});
  w.HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,download:this.download})};
  for(const d of w.document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open')}
  w.fetch=async(url,options={})=>{const body=JSON.parse(options.body||'{}');calls.push(body);assert.equal(body.action,'download_diploma');return new Response(JSON.stringify(fail?{error:'Prøv igjen senere.'}:{url:'https://test.invalid/private-signed.pdf',file_name:'KURS-2026-000042.pdf'}),{status:fail?503:200})};
  w.eval(fs.readFileSync('app.js','utf8')+`;window.diplomaTest={init:()=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'}},render:(data,admin)=>{courseData=data;admin?renderAdminCourses():renderEmployeeCourses()}};`);
  await new Promise(r=>setTimeout(r,0));w.diplomaTest.init();
  const course={id:'course',title:'Test <course>',version:1,status:'locked',modules:[],questions:[]};
  const done={id:'done',course_id:'course',status:'completed',assigned_at:'2026-09-01',completed_at:'2026-09-29',score:100,courses:course,employees:{full_name:'Test <employee>'}};
  const data={courses:[course],employees:[],assignments:[done,{...done,id:'pending',status:'assigned'}]};
  w.diplomaTest.render(data,false);
  assert.equal(w.document.querySelectorAll('#employeeCourses [data-course-diploma]').length,1);
  assert.equal(w.document.querySelector('#employeeCourses button button'),null);
  const employeeButton=w.document.querySelector('#employeeCourses [data-course-diploma]');
  employeeButton.click();assert.equal(employeeButton.disabled,true);await new Promise(r=>setTimeout(r,20));
  assert.equal(downloads[0].download,'KURS-2026-000042.pdf');assert.equal(calls[0].assignment_id,'done');assert.equal(employeeButton.disabled,false);
  assert.equal(w.document.querySelector('#courseReaderDialog').open,false);
  w.diplomaTest.render(data,true);assert.equal(w.document.querySelectorAll('#adminCourses [data-course-diploma]').length,1);assert.equal(w.document.querySelector('#adminCourses employee'),null);
  fail=true;const adminButton=w.document.querySelector('#adminCourses [data-course-diploma]');adminButton.click();await new Promise(r=>setTimeout(r,20));assert.equal(adminButton.disabled,false);assert.equal(adminButton.textContent,'Last ned diplom');assert.equal(downloads.length,1);assert.equal(errors.length,0);
  console.log('PASS: employee/admin diploma actions, escaping, download and retry after error');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
