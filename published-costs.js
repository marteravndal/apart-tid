let publishedCostRequest=0;
const publishedCostDate=date=>new Date(date+'T12:00:00Z').toLocaleDateString('nb-NO',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Oslo'});
const publishedCostRange=p=>p.start===p.end?publishedCostDate(p.start):`${publishedCostDate(p.start)}–${publishedCostDate(p.end)}`;
function publishedCostCoverage(p){
 const notes=[];
 if(p.published_days<p.total_days)notes.push(`${p.published_days} av ${p.total_days} dager har publisert vaktliste`);
 if(p.missing_rates)notes.push(`${p.missing_rates} vakter mangler timesats eller tilleggssats`);
 if(p.invalid_shifts)notes.push(`${p.invalid_shifts} vakter har ugyldige tider`);
 return notes.join(' · ');
}
function renderPublishedCostDashboard(data){
 const today=data.date===localDate(),labels=today?{day:'Dagens lønnskostnad',week:'Ukas lønnskostnad',month:'Månedens lønnskostnad'}:{day:'Valgt dags lønnskostnad',week:'Valgt ukes lønnskostnad',month:'Valgt måneds lønnskostnad'};
 $('#publishedCostCards').innerHTML=data.periods.map(p=>{
  const c=p.current,previous=p.previous,available=c.published_days>0,coverage=publishedCostCoverage(c),previousCoverage=publishedCostCoverage(previous);
  let change='Endring kan ikke beregnes – grunnlaget er ufullstendig.',tone='neutral';
  if(p.change!==null){
   const sign=p.change>0?'+':p.change<0?'−':'';
   change=`${sign}${payrollMoney(Math.abs(p.change))}${p.percent!==null?` (${p.percent>0?'+':''}${new Intl.NumberFormat('nb-NO',{maximumFractionDigits:1}).format(p.percent)} %)`:previous.cost===0?' · prosent kan ikke beregnes fra 0 kr':''}`;
   tone=p.change>0?'increase':p.change<0?'decrease':'neutral';
  }
  return `<article class="published-cost-stat"><h4>${labels[p.key]}</h4><p class="published-cost-period">${escapeHtml(publishedCostRange(c))}</p><strong class="published-cost-value">${available?`${c.complete?'':'≈ '}${payrollMoney(c.cost)}`:'Ikke publisert'}</strong><p class="published-cost-coverage ${coverage?'incomplete':''}">${escapeHtml(coverage||`${c.shifts} vakter · ${new Intl.NumberFormat('nb-NO',{maximumFractionDigits:1}).format(c.hours)} timer`)}</p><div class="published-cost-comparison"><p>Mot ${escapeHtml(publishedCostRange(previous))}</p><p>${previous.published_days?`${previous.complete?'':'≈ '}${payrollMoney(previous.cost)}`:'Ingen publisert vaktliste'}</p>${previousCoverage?`<p class="published-cost-missing">${escapeHtml(previousCoverage)}</p>`:''}<p class="published-cost-change ${tone}">${escapeHtml(change)}</p></div></article>`;
 }).join('');
 $('#publishedCostStatus').textContent=`Planlagt lønn inkl. tillegg, uten sosiale kostnader. Oppdatert ${new Date(data.updated_at).toLocaleTimeString('nb-NO',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Oslo'})}.`;
}
async function loadPublishedCostDashboard(){
 if(currentEmployee?.role!=='admin')return;
 const request=++publishedCostRequest,date=dashboardDate||localDate();
 $('#publishedCostStatus').textContent='Henter siste publiserte vaktlister …';
 $('#publishedCostCards').replaceChildren();
 try{
  const data=await authenticated('/functions/v1/payroll-dashboard',{method:'POST',body:{action:'published_costs',date}});
  if(request!==publishedCostRequest||currentEmployee?.role!=='admin'||date!==(dashboardDate||localDate()))return;
  renderPublishedCostDashboard(data);
 }catch(error){if(request===publishedCostRequest)$('#publishedCostStatus').textContent=error.message||'Kunne ikke hente lønnskostnadene. Trykk Oppdater for å prøve igjen.'}
}
$('#publishedCostRefresh').onclick=()=>loadPublishedCostDashboard();
