/* ADMIN-only, rule-based checks. Reviewing an alert never changes attendance or payroll. */
let controlData=null,controlBusy=false,controlRequest=0,controlLimit=10,controlSelected=null;
const controlDate=value=>value?new Date(`${value}T12:00:00Z`).toLocaleDateString('nb-NO',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Europe/Oslo'}):'';
const controlTime=value=>value?new Date(value).toLocaleString('nb-NO',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Oslo'}):'Pågår';
async function loadControlAssistant(){
 if(currentEmployee?.role!=='admin'||controlBusy)return;
 const requestId=++controlRequest;$('#controlStatus').textContent='Kontrollerer stemplinger og vaktliste …';$('#controlRefresh').disabled=true;
 try{const data=await authenticated('/functions/v1/control-assistant',{method:'POST',body:{action:'load'}});if(requestId!==controlRequest)return;controlData=data;renderControlAssistant()}
 catch(error){if(requestId!==controlRequest)return;$('#controlStatus').textContent=`Kontrollen kunne ikke oppdateres: ${error.message}${controlData?' Listen viser sist hentede data.':''}`}
 finally{if(requestId===controlRequest)$('#controlRefresh').disabled=false}
}
function controlEvidence(d){
 const lines=[];
 if(d.reference_no)lines.push(stampReference(d)+(d.other_reference_no?` og ${stampReference({reference_no:d.other_reference_no})}`:''));
 if(d.started_at)lines.push(`Registrert: ${controlTime(d.started_at)} – ${controlTime(d.ended_at)}`);
 if(d.planned_start)lines.push(`Planlagt: ${controlTime(d.planned_start)} – ${controlTime(d.planned_end)}`);
 if(d.other_start)lines.push(`Overlapper: ${controlTime(d.other_start)} – ${controlTime(d.other_end)}`);
 if(d.absence_start)lines.push(`Fraværsperiode: ${controlDate(d.absence_start)}–${controlDate(d.absence_end)}`);
 if(d.hours!=null)lines.push(`Planlagt: ${hours(d.hours)} · Ukenorm: ${hours(d.norm)} · Stilling: ${Number(d.position_percent).toLocaleString('nb-NO')} %`);
 return lines.map(x=>`<span>${escapeHtml(x)}</span>`).join('');
}
function renderControlAssistant(){
 if(!controlData)return;
 const all=controlData.alerts||[],open=all.filter(a=>a.status==='open'),urgent=open.filter(a=>a.severity===1).length,handled=all.filter(a=>a.status==='handled').length;
 $('#controlSummary').textContent=`${open.length} åpne saker · ${urgent} prioritert · ${handled} behandlet`;
 $('#controlStatus').textContent=`Sist kontrollert ${controlTime(controlData.checked_at)} · Kontrollperiode ${controlDate(controlData.from_date)}–${controlDate(controlData.to_date)}. Åpne stemplinger og usendte varsler kontrolleres også utenfor perioden.`;
 const warnings=[];
 if(!controlData.email_configured)warnings.push('E-postvarsling er ikke konfigurert. Nøkkelen til e-posttjenesten må legges inn i Supabase. Automatisk utstempling fungerer, og varsler blir liggende i kø.');
 const health=controlData.health;
 if(!health?.background_at||Date.now()-new Date(health.background_at).getTime()>15*60000)warnings.push('Bakgrunnskontrollen mangler en nylig bekreftet kjøring. Denne listen kontrolleres på nytt når du trykker Oppdater.');
 else if(!health.clock_job_ok)warnings.push('Automatisk utstempling mangler en nylig vellykket kjøring. Kontroller åpne stemplinger og systemdriften.');
 if(controlData.total>all.length)warnings.push(`Viser ${all.length} av ${controlData.total} saker. Eldre historikk er avkortet.`);
 $('#controlWarnings').innerHTML=warnings.map(x=>`<p class="control-warning">${escapeHtml(x)}</p>`).join('');
 const state=$('#controlFilter').value,category=$('#controlCategory').value;
 const filtered=all.filter(a=>(state==='all'||a.status===state)&&(category==='all'||a.category===category));
 $('#controlRows').innerHTML=filtered.slice(0,controlLimit).map(a=>{const d=a.data,stateText={open:'Åpen',handled:'Behandlet',cleared:'Ikke lenger i kontrollen'}[a.status];return `<article class="control-item ${a.status==='open'&&a.severity===1?'priority':''}"><div class="control-item-top"><div><h4>${escapeHtml(d.title)}</h4><p>${escapeHtml(d.employee_name)}${d.date?` · ${controlDate(d.date)}`:''}</p></div><span class="control-label">${a.status==='open'&&a.severity===1?'Prioritert':stateText}</span></div><p>${escapeHtml(d.detail)}</p><div class="control-evidence">${controlEvidence(d)}</div>${a.comment?`<div class="control-comment"><strong>${a.status==='open'?'Tidligere behandling':'Kommentar'}</strong><p>${escapeHtml(a.comment)}</p><small>${escapeHtml(a.handled_by_name||'ADMIN')} · ${controlTime(a.handled_at)}</small></div>`:''}<div class="actions"><button type="button" class="secondary small" data-control-open="${a.id}" ${controlBusy?'disabled':''}>${d.target==='entry'?'Åpne stempling':'Åpne vaktlisten'}</button>${d.employee_id&&d.date?`<button type="button" class="secondary small" data-control-week="${a.id}" ${controlBusy?'disabled':''}>Kontroller uken</button>`:''}${a.status!=='cleared'?`<button type="button" class="${a.status==='open'?'primary':'secondary'} small" data-control-handle="${a.id}" ${controlBusy?'disabled':''}>${a.status==='open'?'Marker behandlet':'Gjenåpne'}</button>`:''}</div></article>`}).join('')||'<p class="empty">Ingen saker i denne visningen.</p>';
 $('#controlMore').classList.toggle('hidden',filtered.length<=controlLimit);$('#controlMore').textContent=`Vis flere (${Math.max(0,filtered.length-controlLimit)} gjenstår)`;
 $('#controlRefresh').disabled=controlBusy;
}
$('#controlRefresh').onclick=()=>loadControlAssistant();
$('#controlFilter').onchange=$('#controlCategory').onchange=()=>{controlLimit=10;renderControlAssistant()};
$('#controlMore').onclick=()=>{controlLimit+=10;renderControlAssistant()};
$('#controlRows').onclick=async event=>{
 const button=event.target.closest('[data-control-open],[data-control-week],[data-control-handle]');if(!button||controlBusy)return;
 const id=button.dataset.controlOpen||button.dataset.controlWeek||button.dataset.controlHandle,a=controlData?.alerts.find(x=>x.id===id);if(!a)return;const d=a.data;
 if(button.dataset.controlHandle){controlSelected={...a};$('#controlDialogTitle').textContent=a.status==='open'?'Marker saken som behandlet':'Gjenåpne saken';$('#controlDialogCase').textContent=`${d.title} · ${d.employee_name}`;$('#controlComment').value='';$('#controlDialogError').textContent='';$('#controlDialog').showModal();return}
 button.disabled=true;
 try{
  if(button.dataset.controlWeek){activateAdminPanel('approvalPanel',true);$('#weeklyDate').value=rosterMonday(d.date);$('#weeklyFilter').value='all';weeklyEmployeeId=d.employee_id;await loadWeeklyReview();}
  else if(d.target==='entry'){activateAdminPanel('stampingPanel',true);$('#stampingEmployee').value='';$('#stampingStatus').value='all';$('#stampingReference').value=d.reference_no?stampReference(d):'';if(d.date)$('#stampingMonth').value=d.date.slice(0,7);await loadStamping(0);}
  else{activateAdminPanel('rosterAdminPanel',true);rosterWeekStart=rosterMonday(d.date);await loadRoster();}
 }catch(error){show(error.message)}finally{button.disabled=false}
};
$('#controlCancel').onclick=()=>{if(!controlBusy)$('#controlDialog').close()};
$('#controlDialog').addEventListener('cancel',event=>{if(controlBusy)event.preventDefault()});
$('#controlForm').onsubmit=async event=>{
 event.preventDefault();if(controlBusy||!controlSelected)return;
 const comment=$('#controlComment').value.trim();if(comment.length<3){$('#controlDialogError').textContent='Skriv minst tre tegn.';return}
 controlBusy=true;++controlRequest;$('#controlSave').disabled=true;$('#controlCancel').disabled=true;renderControlAssistant();
 try{controlData=await authenticated('/functions/v1/control-assistant',{method:'POST',body:{action:controlSelected.status==='open'?'handle':'reopen',id:controlSelected.id,expected:controlSelected.fingerprint,expected_status:controlSelected.status,comment}});$('#controlDialog').close();controlSelected=null;show('Sakens status er lagret. Timer og lønnsgrunnlag er uendret.');}
 catch(error){$('#controlDialogError').textContent=error.message;}
 finally{controlBusy=false;$('#controlSave').disabled=false;$('#controlCancel').disabled=false;renderControlAssistant()}
};
setInterval(()=>{if(!document.hidden&&currentEmployee?.role==='admin'&&!$('#dashboardPanel').classList.contains('hidden')&&!$('#controlDialog').open)loadControlAssistant()},300000);
