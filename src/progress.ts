import { extractAgentName } from './stream.ts';
export type ReviewPhase = 'starting'|'delegating'|'synthesizing'|'validating'|'cancelling';
export interface ReviewProgressState { phase: ReviewPhase; requiredAgents: string[]; invokedAgents: string[]; }
export function createProgressReducer(requiredAgents:string[], onUpdate:(state:ReviewProgressState)=>void) {
  const required=[...requiredAgents]; let phase:ReviewPhase='starting'; const invoked:string[]=[];
  const snapshot=()=>({phase,requiredAgents:[...required],invokedAgents:[...invoked]});
  const update=()=>onUpdate(snapshot());
  const setPhase=(next:ReviewPhase)=>{phase=next;update();};
  const ingest=(line:string)=>{let event:any;try{event=JSON.parse(line)}catch{return}if(event?.type==='result'){setPhase('validating');return}for(const item of event?.message?.content??[]){const name=extractAgentName(item);if(required.includes(name)&&!invoked.includes(name)){invoked.push(name);phase=invoked.length===required.length?'synthesizing':'delegating';update();}}};
  return {ingest,setPhase,snapshot};
}
