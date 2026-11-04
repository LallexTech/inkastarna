import test from 'node:test';
import assert from 'node:assert/strict';
import { stockholmTime, normalizeMatch } from '../src/lib/korpen';

test('Korpen wall times preserve Stockholm kickoff in winter and summer', () => {
  assert.equal(stockholmTime('2026-11-15 13:30:00'), '2026-11-15T12:30:00.000Z');
  assert.equal(stockholmTime('2027-03-28 13:30:00'), '2027-03-28T11:30:00.000Z');
});
test('unfinished fixtures do not become 0–0 results', () => {
  const match = normalizeMatch({id:1,startTime:'2026-11-15 13:30:00',location:'Stora Mossen',finished:false,result:[],competitors:[{id:10,name:'Inkastarna',team_id:27757},{id:11,name:'Motståndare ',team_id:2}]});
  assert.equal(match.homeScore,null); assert.equal(match.awayScore,null); assert.equal(match.away,'Motståndare');
});
test('numeric scores preserve a genuine zero', () => {
  const match = normalizeMatch({id:1,startTime:'2026-11-15 13:30:00',location:'Stora Mossen',finished:true,result:[0,3],competitors:[{id:10,name:'Inkastarna',team_id:27757},{id:11,name:'Motståndare',team_id:2}]});
  assert.equal(match.homeScore,0); assert.equal(match.awayScore,3);
});
test('official team_id results may arrive in reverse order',()=>{
  const match=normalizeMatch({id:1,startTime:'2026-11-15 13:30:00',location:'Stora Mossen',finished:true,result:[{team_id:2,result:'3'},{team_id:27757,result:'0'}],competitors:[{id:10,name:'Inkastarna',team_id:27757},{id:11,name:'Motståndare',team_id:2}]});
  assert.equal(match.homeScore,0);assert.equal(match.awayScore,3);
});
