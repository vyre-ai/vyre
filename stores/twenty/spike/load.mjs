const base="http://localhost:4000";
const stages=["Intake","Drafting","Review","Filed","Closed"];
async function pool(n,c,fn){let i=0,errs=0;const lat=[];await Promise.all(Array.from({length:c},async()=>{while(i<n){const k=i++;const t=performance.now();try{await fn(k)}catch(e){errs++}lat.push(performance.now()-t)}}));lat.sort((a,b)=>a-b);return{n,c,errs,p50:Math.round(lat[n>>1]),p95:Math.round(lat[Math.floor(n*.95)])}}
const ids=[];
let t=Date.now();
let r=await pool(400,8,async k=>{const x=await fetch(base+"/records/Matter",{method:"POST",headers:{"x-actor":"person:alex"},body:JSON.stringify({title:"Load matter "+k,stage:stages[k%5],opened:"2026-10-03",clientTaxId:"99-"+k})});const j=await x.json();if(!j.id)throw 1;ids.push(j.id)});
console.log("create",JSON.stringify(r),"wall_s",((Date.now()-t)/1000).toFixed(1));
t=Date.now();
r=await pool(400,16,async k=>{const x=await fetch(base+"/records/Matter/"+ids[k%ids.length],{headers:{"x-actor":"assistant:juno"}});if(!(await x.json()).id)throw 1});
console.log("get",JSON.stringify(r),"wall_s",((Date.now()-t)/1000).toFixed(1));
t=Date.now();
r=await pool(100,8,async k=>{const x=await fetch(base+"/records/Matter?stage=Review",{headers:{"x-actor":"assistant:juno"}});await x.json()});
console.log("query100rows",JSON.stringify(r),"wall_s",((Date.now()-t)/1000).toFixed(1));
t=Date.now();
r=await pool(200,8,async k=>{const x=await fetch(base+"/records/Matter/"+ids[k],{method:"PATCH",headers:{"x-actor":"assistant:juno"},body:JSON.stringify({stage:"Closed"})});if(!(await x.json()).id)throw 1});
console.log("update",JSON.stringify(r),"wall_s",((Date.now()-t)/1000).toFixed(1));
