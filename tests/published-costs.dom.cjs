const {JSDOM}=require('jsdom'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://apart.test',runScripts:'outside-only'}),w=dom.window;
 try{
  w.matchMedia=()=>({matches:false});
  const base={start:'2026-11-09',end:'2026-11-09',cost:2000,hours:10,shifts:1,published_days:1,total_days:1,missing_rates:0,invalid_shifts:0,complete:true};
  const data={date:'2026-11-09',updated_at:'2026-11-09T10:00:00Z',periods:[
   {key:'day',current:base,previous:{...base,start:'2026-10-09',end:'2026-10-09',cost:1000},change:1000,percent:100},
   {key:'week',current:{...base,start:'2026-11-09',end:'2026-11-15'},previous:{...base,start:'2026-10-05',end:'2026-10-11',cost:3000},change:-1000,percent:-33.33},
   {key:'month',current:{...base,start:'2026-11-01',end:'2026-11-30',published_days:15,total_days:30,complete:false},previous:{...base,start:'2026-10-01',end:'2026-10-31'},change:null,percent:null}
  ]};
  const calls=[];let reject=false,pending=[];
  w.fetch=async(url,options={})=>{const body=JSON.parse(options.body||'{}');calls.push(body);if(reject)throw new Error('Test failure');if(body.date==='2026-11-10')return new Promise(resolve=>pending.push(()=>resolve(new Response(JSON.stringify({...data,date:body.date})))));return new Response(JSON.stringify({...data,date:body.date}))};
  w.eval(fs.readFileSync('app.js','utf8')+'\n'+fs.readFileSync('payroll-dashboard.js','utf8')+'\n'+fs.readFileSync('published-costs.js','utf8')+`;window.publishedTest={init:()=>{saveSession({access_token:'synthetic',expires_at:Date.now()/1000+3600});currentEmployee={role:'admin'};dashboardDate='2026-11-09'},load:loadPublishedCostDashboard,date:d=>dashboardDate=d};`);
  await new Promise(r=>setTimeout(r,0));w.publishedTest.init();await w.publishedTest.load();
  assert.equal(w.document.querySelector('.dashboard-activity').nextElementSibling.id,'');assert.ok(w.document.querySelector('.dashboard-activity').nextElementSibling.classList.contains('published-cost-panel'));
  assert.equal(w.document.querySelectorAll('.published-cost-stat').length,3);assert.equal(w.document.querySelectorAll('.published-cost-change.increase').length,1);assert.equal(w.document.querySelectorAll('.published-cost-change.decrease').length,1);assert.match(w.document.querySelector('#publishedCostCards').textContent,/15 av 30/);assert.match(w.document.querySelector('#publishedCostCards').textContent,/ufullstendig/);
  assert.deepEqual(calls.at(-1),{action:'published_costs',date:'2026-11-09'});
  w.document.querySelector('#publishedCostRefresh').click();await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,2);
  w.publishedTest.date('2026-11-10');const old=w.publishedTest.load();await new Promise(r=>setTimeout(r,0));w.publishedTest.date('2026-11-11');await w.publishedTest.load();pending[0]();await old;assert.match(w.document.querySelector('.published-cost-stat h4').textContent,/Valgt|Dagens/);assert.equal(w.document.querySelectorAll('.published-cost-stat').length,3);
  reject=true;await w.publishedTest.load();assert.equal(w.document.querySelectorAll('.published-cost-stat').length,0);assert.match(w.document.querySelector('#publishedCostStatus').textContent,/Test failure/);
  console.log('PASS: published-cost cards, placement, comparisons, coverage, refresh, date changes and error state');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
