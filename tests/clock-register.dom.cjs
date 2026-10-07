const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test/',runScripts:'outside-only'}),w=dom.window;
 try{
  const errors=[],calls=[];let deleted=false,conflict=false;
  w.addEventListener('error',e=>errors.push(e.message));w.matchMedia=()=>({matches:false});
  for(const dialog of w.document.querySelectorAll('dialog')){dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open')}
  const employee={id:'emp',full_name:'Test <employee>',employee_number:'TEST',active:true,role:'employee',email:'test@example.invalid'};
  const entry={id:'entry',reference_no:123,employee_id:'emp',employee_name:employee.full_name,employee_number:'TEST',started_at:'2026-10-06T21:01:36Z',ended_at:'2026-10-07T05:41:00Z',source:'qr'};
  const approval=()=>({employee,month:'2026-10',status:'open',entries:deleted?[]:[entry]});
  w.fetch=async(url,options={})=>{
   const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};calls.push({path,body});let data={},status=200;
   if(path.endsWith('/time-review-admin')){
    if(body.action==='register')data={entries:[{...entry,...(deleted?{deleted_at:'2026-10-07T06:00:00Z',deleted_by_name:'Test Admin',deletion_reason:'Mistaken re-entry'}:{})}],employees:[employee],events:deleted?[{entry_id:'entry',at:'2026-10-07T06:00:00Z',actor:'Test Admin',action:'delete_time_entry',reason:'Mistaken re-entry'}]:[],page:body.page,has_more:false};
    if(body.action==='delete'){if(conflict){status=409;data={error:'Registreringen er endret. Oppdater listen før du sletter.'}}else{deleted=true;data={ok:true}}}
    if(body.action==='overview')data={employees:[],status:'open'};
    if(body.action==='load')data=approval();
   }else if(path.endsWith('/employee-admin'))data={employees:[employee]};
   else throw Error('Unexpected request '+path);
   return new Response(JSON.stringify(data),{status});
  };
  w.eval(fs.readFileSync('app.js','utf8')+`;window.testRegister={init:()=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'}},approval:data=>{approvalData=data;renderApproval()},load:loadStamping};`);
  await new Promise(r=>setTimeout(r,0));w.testRegister.init();
  w.testRegister.approval(approval());
  assert.match(w.document.querySelector('#approvalRows').textContent,/ST-000123/);
  w.document.querySelector('[data-time-delete]').click();assert.ok(w.document.querySelector('#deleteStampDialog').open);
  assert.match(w.document.querySelector('#deleteStampSummary').textContent,/23:01:36/);assert.match(w.document.querySelector('#deleteStampSummary').textContent,/Test <employee>/);
  w.document.querySelector('#cancelDeleteStamp').click();assert.equal(calls.filter(x=>x.body.action==='delete').length,0);
  w.document.querySelector('#stampingPanel').classList.remove('hidden');await w.testRegister.load(0);
  assert.match(w.document.querySelector('#stampingRows').textContent,/ST-000123/);assert.equal(w.document.querySelector('#stampingRows employee'),null);
  w.document.querySelector('[data-stamp-delete]').click();const form=w.document.querySelector('#deleteStampForm');
  await form.onsubmit({preventDefault(){}});assert.equal(calls.filter(x=>x.body.action==='delete').length,0);
  w.document.querySelector('#deleteStampReason').value='Mistaken re-entry';conflict=true;await form.onsubmit({preventDefault(){}});assert.match(w.document.querySelector('#deleteStampError').textContent,/endret/);assert.ok(w.document.querySelector('#deleteStampDialog').open);
  conflict=false;await form.onsubmit({preventDefault(){}});assert.equal(w.document.querySelector('#deleteStampDialog').open,false);
  assert.match(w.document.querySelector('#stampingRows').textContent,/Slettet.*Mistaken re-entry/s);assert.equal(w.document.querySelector('[data-stamp-delete]'),null);
  const request=calls.find(x=>x.body.action==='delete');assert.equal(request.body.entry_id,'entry');assert.equal(request.body.ended_at,entry.ended_at);
  w.testRegister.approval({...approval(),status:'locked',entries:[entry]});assert.equal(w.document.querySelector('[data-time-delete]'),null);
  assert.deepEqual(errors,[]);console.log('Register DOM passed: references, confirmation/cancel, reason, stale-entry rejection, successful archive, escaped content, locked rows. Synthetic data only.');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
