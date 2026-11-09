const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{stripTypeScriptTypes}=require('node:module');
const compile=p=>stripTypeScriptTypes(fs.readFileSync(p,'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''));
const premium=new Function(compile('supabase/functions/_shared/payroll-premiums.ts')+';return premiumHoursBetween')();
const {shiftBounds}=new Function('premiumHoursBetween',compile('supabase/functions/_shared/payroll-forecast.ts')+';return {shiftBounds}')(premium);
const {matchRosterAttendance,loadRosterAttendance}=new Function('shiftBounds',compile('supabase/functions/_shared/roster-attendance.ts')+';return {matchRosterAttendance,loadRosterAttendance}')(shiftBounds);
const shift=(id,date,start='16:00',end='23:00',employee='e')=>({id,employee_id:employee,work_date:date,start_time:start,end_time:end});
const entry=(id,start,end,patch={})=>({id,employee_id:'e',reference_no:64,kind:'work',source:'location',scheduled_shift_id:null,started_at:start,ended_at:end,...patch});
test('employee punches display without persisted roster links; late arrival is preserved',()=>{
 const e=entry('t','2026-11-02T15:59:41Z','2026-11-02T22:00:58Z'),r=matchRosterAttendance([shift('s','2026-11-02')],[e],['s']);
 assert.equal(r.length,1);assert.equal(r[0].matched_shift_id,'s');assert.equal(r[0].scheduled_shift_id,null);assert.equal(r[0].match_method,'time');assert.equal(e.scheduled_shift_id,null);assert.equal(r[0].started_at,e.started_at);
});
test('midnight early entry matches next date, overnight and neighbouring-week context work',()=>{
 const shifts=[shift('sun','2026-11-08','23:00','07:00'),shift('mon','2026-11-09','00:00','06:00')];
 const e=entry('t','2026-11-08T22:57:00Z','2026-11-09T05:02:00Z');
 // Overlapping same-employee roster slots are deliberately ambiguous.
 let r=matchRosterAttendance(shifts,[e],['mon']);assert.equal(r[0].match_method,'ambiguous');
 r=matchRosterAttendance([shift('prev','2026-11-08','00:00','06:00'),shifts[1]],[e],['mon']);assert.equal(r[0].matched_shift_id,'mon');assert.equal(r[0].match_method,'time');
 r=matchRosterAttendance([shift('sun','2026-11-08','23:00','07:00'),shift('mon','2026-11-09','16:00','23:00')],[e],['mon']);assert.equal(r.length,0);
});
test('split intervals retain both references; no match is made to another employee',()=>{
 const s=shift('s','2026-11-05','00:00','08:00'),a=entry('a','2026-11-04T22:58:51Z','2026-11-04T23:10:14Z'),b=entry('b','2026-11-04T23:13:28Z','2026-11-05T07:02:38Z',{reference_no:77});
 const r=matchRosterAttendance([s,shift('other','2026-11-05','00:00','08:00','other')],[a,b],['s','other']);assert.equal(r.length,2);assert.ok(r.every(e=>e.matched_shift_id==='s'));assert.equal(r[1].reference_no,77);
});
test('an early open punch selects the coming shift instead of the ending shift',()=>{
 const shifts=[shift('day','2026-11-05','08:00','16:00'),shift('evening','2026-11-05')],e=entry('t','2026-11-05T14:55:00Z',null);
 const r=matchRosterAttendance(shifts,[e],['day','evening'],Date.parse('2026-11-05T14:56:00Z'));assert.equal(r.length,1);assert.equal(r[0].matched_shift_id,'evening');assert.equal(r[0].ended_at,null);
});
test('explicit links are authoritative, conflicts flagged, auto-clock and sickness retained',()=>{
 const shifts=[shift('s','2026-11-05'),shift('other','2026-11-05','08:00','16:00','other')];
 const e=entry('t','2026-11-05T07:00:00Z','2026-11-05T19:00:00Z',{scheduled_shift_id:'s',auto_clocked_out:true,kind:'sick_pay',source:'manual'});
 let r=matchRosterAttendance(shifts,[e],['s']);assert.equal(r[0].match_method,'linked');assert.equal(r[0].auto_clocked_out,true);assert.equal(r[0].kind,'sick_pay');
 e.scheduled_shift_id='other';r=matchRosterAttendance(shifts,[e],['s','other']);assert.equal(r.length,1);assert.equal(r[0].match_method,'linked_conflict');
 e.scheduled_shift_id='deleted-slot';assert.equal(matchRosterAttendance(shifts,[e],['s']).length,0);
});
test('duplicate slots and intervals covering two shifts require review; unrelated times stay unassigned',()=>{
 const shifts=[shift('s','2026-11-05'),shift('duplicate','2026-11-05')],e=entry('t','2026-11-05T15:00:00Z','2026-11-05T22:00:00Z');
 assert.ok(matchRosterAttendance(shifts,[e],['s','duplicate']).every(x=>x.match_method==='ambiguous'));
 assert.equal(matchRosterAttendance(shifts,[entry('early','2026-11-05T06:00:00Z','2026-11-05T07:00:00Z')],['s']).length,0);
});
const sid='11111111-1111-4111-8111-111111111111';
function dbMock(fail=false){const calls=[];return {calls,from(table){const q={table,filters:[]};calls.push(q);const builder={select(v){q.select=v;return this},eq(k,v){q.filters.push([k,v]);return this},in(k,v){q.filters.push([k,v]);return this},gte(){return this},lte(){return this},lt(){return this},limit(){return this},then(resolve,reject){let data=table==='scheduled_shifts'?[shift(sid,'2026-11-05')]:[entry('t','2026-11-05T15:00:00Z','2026-11-05T22:00:00Z')];return Promise.resolve({data,error:fail?{}:null}).then(resolve,reject)}};return builder}}}
test('loader reads only same-org shifts and entries, de-duplicates and fails closed on query errors',async()=>{
 const db=dbMock(),r=await loadRosterAttendance(db,'org',[sid]);assert.equal(r.length,1);for(const q of db.calls)assert.ok(q.filters.some(([k,v])=>k==='organization_id'&&v==='org'));
 assert.ok(db.calls.every(q=>!q.select.includes('note')&&!q.select.includes('latitude')));await assert.rejects(()=>loadRosterAttendance(dbMock(true),'org',[sid]));
});
test('attendance API validates input and requires active admin, ignores supplied organization',async()=>{
 async function call(role,active,body,auth=true){let handler,captured;const admin={auth:{getUser:async()=>({data:{user:{id:'actor'}}})},from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{role,active,organization_id:'org'}})})};vm.runInNewContext(compile('supabase/functions/time-review-admin/index.ts'),{Deno:{env:{get:()=>''},serve:f=>handler=f},createClient:()=>admin,premiumHoursBetween:premium,loadRosterAttendance:async(_db,org,ids)=>{captured={org,ids};return[]},Request,Response});const response=await handler(new Request('https://test.invalid',{method:'POST',headers:auth?{Authorization:'Bearer test'}:{},body:JSON.stringify(body)}));return{response,captured}}
 const body={action:'roster_attendance',shift_ids:[sid],organization_id:'forged'};
 assert.equal((await call('employee',true,body)).response.status,403);assert.equal((await call('admin',false,body)).response.status,403);assert.equal((await call('admin',true,body,false)).response.status,401);
 assert.equal((await call('admin',true,{...body,shift_ids:['bad']})).response.status,400);
 const r=await call('admin',true,body);assert.equal(r.response.status,200);assert.equal(r.captured.org,'org');
});
