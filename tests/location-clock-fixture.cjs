const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const compiled=stripTypeScriptTypes(fs.readFileSync('supabase/functions/time-clock/index.ts','utf8').replace(/^import .*;\n/gm,''));
function fixture(options={}){
  let handler,openEntry=options.openEntry||null;
  const writes=[],queries=[],qrUrls=[];
  const employee={id:'test-employee',organization_id:'test-org',full_name:'Test Ansatt',role:options.role||'employee',active:options.active!==false};
  const worksite={id:'test-site',name:'Teststed',address:'Testadresse',latitude:59,longitude:6,radius_meters:100};
  const entries=[];
  const db={auth:{getUser:async()=>({data:{user:options.unauthenticated?null:{id:'test-user'}}})},from(table){
    const q={table,kind:'read',filters:[]};queries.push(q);const builder={};
    for(const method of ['select','eq','is','gte','order','limit'])builder[method]=(...args)=>{q.filters.push([method,...args]);return builder};
    for(const method of ['insert','update'])builder[method]=values=>{q.kind=method;q.values=values;writes.push(q);return builder};
    const result=(single)=>{
      if(table==='employees')return{data:employee};
      if(table==='worksites')return{data:worksite};
      if(table==='time_entries'){
        if(q.kind==='read')return options.statusError?{error:{message:'offline'}}:{data:single?openEntry:entries};
        if(q.kind==='insert'){openEntry={id:'test-entry',...q.values};entries.push(openEntry);return{data:openEntry}}
        if(options.raceOut)return{data:null};
        const entry={...openEntry,...q.values};openEntry=null;return{data:entry};
      }
      if(table==='qr_codes')throw new Error('QR codes must not be used for attendance');
      return{data:[]};
    };
    builder.single=async()=>result(true);builder.maybeSingle=async()=>result(true);builder.then=(resolve,reject)=>Promise.resolve(result(false)).then(resolve,reject);return builder;
  }};
  vm.runInNewContext(compiled,{Deno:{env:{get:()=> 'test'},serve:fn=>{handler=fn}},createClient:()=>db,QRCode:{toString:async value=>{qrUrls.push(value);return '<svg></svg>'}},crypto:globalThis.crypto,TextEncoder,Request,Response,URL,console,btoa});
  async function call(body,method='POST',auth=true){const response=await handler(new Request('https://example.invalid/time-clock',{method,headers:{...(auth?{Authorization:'Bearer test'}:{}),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}));return{status:response.status,body:await response.json()}}
  return{call,writes,queries,qrUrls,employee,worksite};
}
module.exports={fixture};
