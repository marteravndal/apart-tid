const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
const shared=stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/course-diplomas.ts','utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''));
const scope=new Function('PDFDocument','StandardFonts','rgb',shared+';return {courseDiplomaPdf,diplomaReference,ensureCourseDiploma};')(PDFDocument,StandardFonts,rgb);
const sample={id:'diploma',reference_no:42,assignment_id:'assignment',organization_id:'org',employee_id:'employee',snapshot:{employee_name:'Eksempel Ansatt',course_title:'Vold og Trusler på arbeidsplassen - Del 1',course_version:1,completed_at:'2026-09-29T22:30:00Z',issuer:'Apart Stavanger AS',template_version:1}};
test('PDF is one landscape A4 page and uses immutable title, reference and completion date',async()=>{
 const bytes=await scope.courseDiplomaPdf(sample),pdf=await PDFDocument.load(bytes);
 assert.equal(pdf.getPageCount(),1);assert.ok(Math.abs(pdf.getPage(0).getWidth()-841.89)<.01);assert.ok(Math.abs(pdf.getPage(0).getHeight()-595.28)<.01);
 assert.equal(pdf.getTitle(),'Kursdiplom – '+sample.snapshot.course_title);assert.equal(pdf.getSubject(),'KURS-2026-000042');assert.equal(pdf.getCreationDate().getTime(),new Date(sample.snapshot.completed_at).getTime());
 fs.mkdirSync('tmp/pdfs',{recursive:true});fs.writeFileSync('tmp/pdfs/course-diploma-preview.pdf',bytes);
 const long={...sample,snapshot:{...sample.snapshot,employee_name:'Anne-Marie Østergård Ås Johannessen Eksempelnavn',course_title:'Et lengre kursnavn om forebygging og håndtering av utfordrende situasjoner på arbeidsplassen'}};
 fs.writeFileSync('tmp/pdfs/course-diploma-long.pdf',await scope.courseDiplomaPdf(long));
 assert.equal(scope.diplomaReference({...sample,snapshot:{...sample.snapshot,completed_at:'2026-12-31T23:30:00Z'}}),'KURS-2027-000042');
});
function storageFixture(options={}){
 let uploadedPath;const calls=[];const client={from(table){const q={table,filters:[]};calls.push(q);const b={eq:(...args)=>{q.filters.push(args);return b},select:()=>b};
 b.maybeSingle=async()=>({data:options.missing?null:{...sample,document_id:options.existing?'existing-doc':null}});
 b.single=async()=>({data:{storage_path:options.race?'other-path':uploadedPath}});return b;
 },rpc:async(name,args)=>{calls.push({name,args});return options.rpcFailure?{error:{message:'offline'}}:{data:'doc'}},storage:{from(bucket){return{upload:async(path,bytes)=>{uploadedPath=path;calls.push({upload:path,bucket,size:bytes.length});return options.uploadFailure?{error:{message:'offline'}}:{}},remove:async(paths)=>{calls.push({remove:paths});return{}}}}}};
 return{client,calls};
}
test('an existing PDF is reused and never uploaded twice',async()=>{const f=storageFixture({existing:true});assert.equal((await scope.ensureCourseDiploma(f.client,'org','assignment')).document_id,'existing-doc');assert.equal(f.calls.filter(x=>x.upload).length,0)});
test('private upload is finalized only after success; race loser cleans its own file',async()=>{
 for(const race of [false,true]){const f=storageFixture({race});assert.equal((await scope.ensureCourseDiploma(f.client,'org','assignment')).document_id,'doc');assert.equal(f.calls.find(x=>x.upload).bucket,'hr-documents');assert.equal(f.calls.filter(x=>x.remove).length,race?1:0);assert.equal(f.calls.find(x=>x.name).args.p_organization_id,'org')}
 const f=storageFixture({uploadFailure:true});await assert.rejects(scope.ensureCourseDiploma(f.client,'org','assignment'));assert.equal(f.calls.filter(x=>x.name).length,0);
 const ambiguous=storageFixture({rpcFailure:true});await assert.rejects(scope.ensureCourseDiploma(ambiguous.client,'org','assignment'));assert.equal(ambiguous.calls.filter(x=>x.remove).length,0);
});
const edge=stripTypeScriptTypes(fs.readFileSync('supabase/functions/courses/index.ts','utf8').replace(/^import .*;\n/gm,''));
function edgeFixture(options={}){
 let handler;const queries=[],rpcCalls=[],generated=[];
 const client={auth:{getUser:async()=>({data:{user:options.invalidAuth?null:{id:'user'}}})},from(table){
  const q={table,filters:[]};queries.push(q);const b={};for(const method of ['select','eq','neq','order','limit'])b[method]=(...args)=>{q.filters.push([method,...args]);return b};
  const get=()=>{
   if(table==='employees')return{data:{id:'employee',organization_id:'org',role:options.role||'employee',active:!options.inactive}};
   if(table==='course_assignments')return{data:options.denied?null:{id:'assignment',status:'assigned',attempts:0,courses:{status:'locked',passing_score:80,questions:[{id:'q',text:'Question',options:['Yes','No'],correct_index:0,active:true}]}}};
   if(table==='hr_documents')return{data:{storage_path:'private-path',original_name:'diploma.pdf'}};
   throw Error('Unexpected table '+table);
  };b.maybeSingle=async()=>get();b.single=async()=>get();return b;
 },rpc:async(name,args)=>{rpcCalls.push({name,args});return{data:{score:args.p_score,passed:args.p_passed}}},storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://test.invalid/signed'}})})}};
 vm.runInNewContext(edge,{Deno:{env:{get:()=> 'test'},serve:fn=>handler=fn},createClient:()=>client,ensureCourseDiploma:async(...args)=>{generated.push(args);if(options.pdfFailure)throw Error('offline');return{document_id:'doc'}},repairPendingDiplomas:async()=>{},Request,Response,crypto,console:{error:()=>{}}});
 return{queries,rpcCalls,generated,call:async(body,auth=true)=>{const r=await handler(new Request('https://test.invalid',{method:'POST',headers:auth?{Authorization:'Bearer test'}:{},body:JSON.stringify(body)}));return{status:r.status,body:await r.json()}}};
}
test('diploma download requires login, active user, completed assignment and scopes employee + org',async()=>{
 const body={action:'download_diploma',assignment_id:'assignment',organization_id:'forged'};
 assert.equal((await edgeFixture().call(body,false)).status,401);
 for(const opt of [{invalidAuth:true},{inactive:true},{denied:true}]){const f=edgeFixture(opt);assert.ok([401,403,404].includes((await f.call(body)).status));assert.equal(f.generated.length,0)}
 for(const role of ['employee','admin']){const f=edgeFixture({role});assert.equal((await f.call(body)).status,200);const q=f.queries.find(x=>x.table==='course_assignments');assert.ok(q.filters.some(x=>x[1]==='organization_id'&&x[2]==='org'));assert.ok(q.filters.some(x=>x[1]==='status'&&x[2]==='completed'));assert.equal(q.filters.some(x=>x[1]==='employee_id'&&x[2]==='employee'),role==='employee')}
});
test('passed course survives PDF outage; failed test never produces a diploma; score is server-calculated',async()=>{
 const body={action:'submit',assignment_id:'assignment',answers:[{question_id:'q',option_index:0}],score:0,passed:false,employee_id:'forged'};
 const passed=edgeFixture({pdfFailure:true}),r=await passed.call(body);assert.equal(r.status,200);assert.equal(r.body.passed,true);assert.equal(r.body.diploma_ready,false);assert.equal(passed.rpcCalls[0].args.p_employee_id,'employee');assert.equal(passed.rpcCalls[0].args.p_score,100);
 const failed=edgeFixture(),bad=await failed.call({...body,score:100,passed:true,answers:[{question_id:'q',option_index:1}]});assert.equal(bad.body.passed,false);assert.equal(failed.generated.length,0);
});
