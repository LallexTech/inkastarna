import type { Match } from './types';
export function calendarEvent(match: Match) {
  const clean=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const stamp=(s:string)=>new Date(s).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Inkastarna//Lagapp//SV','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:korpen-${match.id}@inkastarna.vercel.app`,`DTSTAMP:${stamp(new Date().toISOString())}`,`DTSTART:${stamp(match.startsAt)}`,`DTEND:${stamp(new Date(new Date(match.startsAt).getTime()+30*60000).toISOString())}`,`SUMMARY:${clean(match.home+' – '+match.away)}`,`LOCATION:${clean(match.location)}`,'DESCRIPTION:Innefotboll 2 × 15 min. Samling 20 min före avspark. Kontrollera aktuellt schema i lagappen.','END:VEVENT','END:VCALENDAR'].join('\r\n');
}
