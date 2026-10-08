let payrollDashboardRequest=0,rosterPlanningRequest=0,rosterPlanningDays=[];
const payrollMoney=n=>new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:0}).format(Number(n||0));
const payrollDate=d=>new Date(d+'T12:00:00Z').toLocaleDateString('nb-NO',{day:'numeric',month:'short',timeZone:'Europe/Oslo'});
async function loadPayrollDashboard(){
 if(currentEmployee?.role!=='admin')return;
 const request=++payrollDashboardRequest,month=$('#payrollCostMonth').value+'-01';
 $('#payrollCostStatus').textContent='Henter lønnskostnader …';$('#payrollCostContent').classList.add('hidden');
 try{const data=await authenticated('/functions/v1/payroll-dashboard',{method:'POST',body:{action:'load',month}});if(request!==payrollDashboardRequest)return;renderPayrollDashboard(data)}
 catch(error){if(request===payrollDashboardRequest)$('#payrollCostStatus').textContent=error.message||'Kunne ikke hente lønnskostnader.'}
}
function renderPayrollDashboard(data){
 const t=data.totals,cards=[['Påløpt hittil',t.actual,'Registrerte timer og etterregistreringer'],['Planlagt i måneden',t.planned,'Alle oppsatte vakter, inkludert utkast'],[data.incomplete?'Månedsprognose · ufullstendig':'Forventet månedskostnad',t.forecast,'Registrert + gjenstående + uavklart + anslag'],['Avvik fra plan',t.variance,`${t.compared_shifts} ferdige vakter sammenlignet; ekstravakter inkludert`]];
 $('#payrollCostCards').innerHTML=cards.map(([label,value,hint],i)=>`<article class="payroll-cost-stat ${i===2?'forecast':''}"><span>${escapeHtml(label)}</span><strong>${data.incomplete&&i<3?'≈ ':''}${i===3&&value>0?'+':''}${payrollMoney(value)}</strong><small>${escapeHtml(hint)}</small></article>`).join('');
 const parts=[['Registrert',t.actual,'actual'],['Løpende stempling',t.provisional,'provisional'],['Gjenstående planlagt',t.remaining,'remaining'],['Uavklart stempling',t.unrecorded,'unrecorded'],['Anslag',t.estimate,'estimate']],positiveTotal=parts.reduce((n,p)=>n+Math.max(0,p[1]),0);
 $('#payrollCostBar').innerHTML=parts.filter(p=>p[1]>0).map(([label,value,cls])=>`<span class="${cls}" style="flex:${value/Math.max(1,positiveTotal)}" title="${label}: ${payrollMoney(value)}"></span>`).join('');
 $('#payrollCostLegend').innerHTML=parts.map(([label,value,cls])=>`<span><i class="${cls}"></i>${label}: <strong>${payrollMoney(value)}</strong></span>`).join('');
 $('#payrollCostBasis').textContent=data.estimated_days?`Anslag for ${data.estimated_days} dager basert på publisert uke ${payrollDate(data.baseline_week)}–${payrollDate(dashboardAddDays(data.baseline_week,6))}. ${data.baseline_confirmed?'Referanseuken er bekreftet ferdig planlagt.':'Referanseuken er ikke bekreftet ferdig planlagt.'}`:'Ingen ekstra vakter er anslått fra en referanseuke.';
 $('#payrollCostWarnings').innerHTML=data.warnings.map(w=>`<p class="payroll-cost-warning">${escapeHtml(w)}</p>`).join('');
 $('#payrollCostRows').innerHTML=data.days.map(d=>`<tr><td>${payrollDate(d.date)}</td><td>${payrollMoney(d.actual)}</td><td>${payrollMoney(d.provisional)}</td><td>${payrollMoney(d.remaining)}</td><td>${payrollMoney(d.unrecorded)}</td><td>${payrollMoney(d.estimate)}</td><td>${d.no_reference?'Mangler grunnlag':d.complete?'Ferdig planlagt':d.status==='draft'?'Utkast':d.estimated_slots?'Inkluderer anslag':'Ikke bekreftet'}${d.incomplete?' · Sats mangler':''}</td></tr>`).join('');
 $('#payrollCostStatus').textContent=`Oppdatert ${new Date(data.updated_at).toLocaleTimeString('nb-NO',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit'})} · ${data.unapproved_count} registreringer venter på godkjenning · ${data.open_count} åpne stemplinger`;
 $('#payrollCostContent').classList.remove('hidden');
}
async function loadRosterPlanning(){
 if(currentEmployee?.role!=='admin')return;const request=++rosterPlanningRequest,date=rosterWeekStart;
 $('#rosterPlanningDays').textContent='Henter planleggingsstatus …';
 try{const data=await authenticated('/functions/v1/payroll-dashboard',{method:'POST',body:{action:'planning',month:date.slice(0,7)+'-01',date}});if(request!==rosterPlanningRequest)return;rosterPlanningDays=data.days;renderRosterPlanning()}
 catch(error){if(request===rosterPlanningRequest)$('#rosterPlanningDays').textContent=error.message}
}
function renderRosterPlanning(){
 $('#rosterPlanningDays').innerHTML=rosterPlanningDays.map(d=>`<label class="payroll-plan-day"><input type="checkbox" data-plan-date="${d.date}" ${d.complete?'checked':''}><span><strong>${new Date(d.date+'T12:00:00Z').toLocaleDateString('nb-NO',{weekday:'short'})} ${payrollDate(d.date)}</strong><small>${d.shifts.length} vakter · ${d.complete?'Ferdig':'Ikke bekreftet'}</small></span></label>`).join('');
}
$('#rosterPlanningDays').onchange=async event=>{
 const input=event.target.closest('[data-plan-date]');if(!input)return;const d=rosterPlanningDays.find(x=>x.date===input.dataset.planDate);if(!d)return;
 const complete=input.checked,date=d.date,week=rosterWeekStart;
 $('#rosterPlanningDays').querySelectorAll('input').forEach(x=>x.disabled=true);
 try{const data=await authenticated('/functions/v1/payroll-dashboard',{method:'POST',body:{action:'complete_day',month:date.slice(0,7)+'-01',date,complete,expected:d.fingerprint}});if(week===rosterWeekStart){rosterPlanningDays=data.days;renderRosterPlanning()}show(complete?'Dagen er markert ferdig planlagt.':'Dagen er åpnet for prognose igjen.')}
 catch(error){show(error.message);await loadRosterPlanning()}
};
$('#payrollCostMonth').value=localDate().slice(0,7);
$('#payrollCostMonth').onchange=()=>{if($('#payrollCostMonth').value)loadPayrollDashboard()};
$('#payrollCostRefresh').onclick=()=>loadPayrollDashboard();
$('#payrollCostPlan').onclick=()=>activateAdminPanel('rosterAdminPanel');
