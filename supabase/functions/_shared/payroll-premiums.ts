const timeZone="Europe/Oslo";

const localDate=(value:string)=>new Intl.DateTimeFormat("sv-SE",{timeZone}).format(new Date(value));
const addDays=(value:string,days:number)=>{const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10)};
const wallMs=(date:string,minutes:number)=>{const targetDate=minutes===1440?addDays(date,1):date,targetMinutes=minutes===1440?0:minutes,[year,month,day]=targetDate.split("-").map(Number),hour=Math.floor(targetMinutes/60),minute=targetMinutes%60,wanted=Date.UTC(year,month-1,day,hour,minute);let guess=wanted;for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess)).reduce((result:any,part)=>(result[part.type]=Number(part.value)||part.value,result),{});guess+=wanted-Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute)}return guess};
const overlapHours=(start:number,end:number,from:number,to:number)=>Math.max(0,Math.min(end,to)-Math.max(start,from))/3600000;
const roundHours=(value:number)=>Math.round((value+Number.EPSILON)*10000)/10000;

export type PremiumHours={evening:number;night:number;weekend:number};

export const premiumHoursBetween=(startedAt:string,endedAt:string|null):PremiumHours=>{
  const start=new Date(startedAt).getTime(),end=endedAt?new Date(endedAt).getTime():NaN,result:PremiumHours={evening:0,night:0,weekend:0};
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return result;
  const lastDate=localDate(endedAt!);let date=localDate(startedAt),guard=0;
  while(date<=lastDate&&guard++<370){
    const day=new Date(`${date}T12:00:00Z`).getUTCDay();
    result.night+=overlapHours(start,end,wallMs(date,0),wallMs(date,360));
    if(day>=1&&day<=5)result.evening+=overlapHours(start,end,wallMs(date,1260),wallMs(date,1440));
    if(day===6)result.weekend+=overlapHours(start,end,wallMs(date,1080),wallMs(date,1440));
    if(day===0)result.weekend+=overlapHours(start,end,wallMs(date,360),wallMs(date,1440));
    date=addDays(date,1);
  }
  return{evening:roundHours(result.evening),night:roundHours(result.night),weekend:roundHours(result.weekend)};
};
