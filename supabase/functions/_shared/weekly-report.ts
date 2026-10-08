import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export function weeklyPayrollLines(report: any): any[] {
 return report.employees.flatMap((p:any)=>{
  const s=p.summary,r=s.payroll_codes;
  return [["ordinary","Arbeid",s.work_hours,s.hourly_rate],["sick_pay","Sykepenger",s.sick_hours,s.hourly_rate],
   ["evening","Kveldstillegg",s.evening_hours,r.evening?.hourly_rate],["night","Nattillegg",s.night_hours,r.night?.hourly_rate],
   ["weekend","Helgetillegg",s.weekend_hours,r.weekend?.hourly_rate],["overtime_40","Overtidstillegg 40 %",s.overtime_40_hours,s.hourly_rate==null?null:s.hourly_rate*.4],
   ["overtime_100","Overtidstillegg 100 %",s.overtime_100_hours,s.hourly_rate]]
   .filter(x=>Number(x[2])!==0).map(([key,label,hours,rate])=>({employee:p.employee.full_name,number:p.employee.employee_number,code:r[key]?.code||"Ikke satt",label,hours:Number(hours),rate:rate==null?null:Number(rate),cost:rate==null?null:Number(hours)*Number(rate)}));
 });
}

export async function weeklyReportPdf(data:any):Promise<Uint8Array>{
 const report=data.report,pdf=await PDFDocument.create(),regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const green=rgb(.07,.16,.13),muted=rgb(.35,.41,.38),line=rgb(.85,.89,.86),width=841.89,height=595.28,margin=38;
 const number=(n:any)=>Number(n||0).toLocaleString("nb-NO",{minimumFractionDigits:2,maximumFractionDigits:2}).replace(/\u00a0/g," ");
 const date=(v:string)=>new Date(`${v}T12:00:00Z`).toLocaleDateString("nb-NO");
 let page:any,y=0,pageNo=0;
 pdf.setTitle(`Ukerapport ${report.week_start} - versjon ${data.revision}`);pdf.setAuthor("Apart Stavanger AS");
 const text=(value:any,x:number,at:number,size=10,font=regular,color=green)=>page.drawText(String(value??""),{x,y:at,size,font,color});
 const newPage=()=>{page=pdf.addPage([width,height]);pageNo++;y=height-42;text("APART STAVANGER AS",margin,y,10,bold);text(`Ukerapport ${date(report.week_start)} - ${date(report.week_end)}`,margin,y-28,19,bold);text(`Versjon ${data.revision} | Låst ${new Date(data.locked_at).toLocaleString("nb-NO",{timeZone:"Europe/Oslo"})}${data.superseded_at?" | TIDLIGERE RAPPORTVERSJON":""}`,margin,y-47,9,regular,muted);text(`Side ${pageNo}`,width-margin-40,22,9,regular,muted);y-=80;};
 const wrap=(value:any,max:number,size=10)=>{const lines:string[]=[];let current="";for(const char of String(value??"")){if(char==='\n'||regular.widthOfTextAtSize(current+char,size)>max){lines.push(current);current=char==='\n'?"":char}else current+=char}lines.push(current);return lines};
 const table=(headers:string[],rows:any[][],widths:number[])=>{
  const head=()=>{page.drawRectangle({x:margin,y:y-10,width:width-2*margin,height:25,color:green});let x=margin+7;headers.forEach((h,i)=>{text(h,x,y,9,bold,rgb(1,1,1));x+=widths[i]});y-=30;};
  head();for(const row of rows){const cells=row.map((v,i)=>wrap(v,widths[i]-14)),h=Math.max(...cells.map(c=>c.length))*13+14;if(y-h<48){newPage();head()}let x=margin+7;cells.forEach((cell,i)=>{cell.forEach((t,k)=>text(t,x,y-k*13,9.5));x+=widths[i]});y-=h;page.drawLine({start:{x:margin,y:y+7},end:{x:width-margin,y:y+7},color:line,thickness:.5});}y-=10;
 };
 newPage();
 const totals=report.employees.reduce((s:any,p:any)=>({hours:s.hours+Number(p.summary.work_hours),sick:s.sick+Number(p.summary.sick_hours),cost:s.cost+Number(p.summary.total_cost),incomplete:s.incomplete||p.summary.cost_incomplete}),{hours:0,sick:0,cost:0,incomplete:false});
 text(`Arbeid: ${number(totals.hours)} t     Sykepenger: ${number(totals.sick)} t     ${totals.incomplete?"Kjent kostnad":"Samlet kostnad"}: ${number(totals.cost)} kr`,margin,y,11,bold);y-=22;
 text("Uten sosiale kostnader. Satser og grunnlag er bevart fra låsingen.",margin,y,9,regular,muted);y-=22;
 if(totals.incomplete){text("* Ufullstendig kostnad: én eller flere satser manglet ved låsing. Bare kjent kostnad er summert.",margin,y,9,bold,rgb(.56,.17,.1));y-=22;}
 table(["Ansatt","Arbeid (t)","Syk (t)","Grunnlønn","Tillegg","Kostnad (kr)"],report.employees.map((p:any)=>[p.employee.full_name,number(p.summary.work_hours),number(p.summary.sick_hours),number(p.summary.base_cost),number(p.summary.premium_cost),number(p.summary.total_cost)+(p.summary.cost_incomplete?" *":"")]),[250,90,75,115,110,126]);
 newPage();text("Lønnsarter per ansatt",margin,y,14,bold);y-=27;
 table(["Ansatt","Lønnsart / beskrivelse","Timer","Sats (kr)","Beløp (kr)"],weeklyPayrollLines(report).map(x=>[x.employee,`${x.code} - ${x.label}`,number(x.hours),x.rate==null?"Mangler":number(x.rate),x.cost==null?"Mangler":number(x.cost)]),[235,250,80,95,106]);
 if(y<75)newPage();text("Overtid vises som tillegg til ordinær timelønn. Sykepenger gir ikke kvelds-, natt- eller helgetillegg.",margin,y,9,regular,muted);
 return pdf.save();
}
