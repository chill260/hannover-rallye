const rallyConfig=window.RALLYE_CONFIG||{};
const rallySupabase=window.supabase.createClient(rallyConfig.supabaseUrl,rallyConfig.supabasePublishableKey);
let dbReady=false,currentUserId=null,routeQuestions={},teamAnswers={};

function freshState(){return{loggedIn:false,username:null,team:null,role:"player",step:0,hints:0,attempts:0,passed:{},phase:"question",branchFromStation:null,correctAnswers:0,penaltyPoints:0,demoMode:false,simulateWrong:false}}
function escapeHtml(v){return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function questionKey(){return state.step===0?-1:state.step-1}
function questionForTeam(t){return state.team==="A"?t.questionA:t.questionB}
function hintForTeam(t){return state.team==="A"?t.hintA:t.hintB}

async function loadGame(){
 const {data:s}=await rallySupabase.auth.getSession(); if(!s?.session)return false;
 currentUserId=s.session.user.id;
 const {data:p,error:pe}=await rallySupabase.from("profiles").select("username,team,role").eq("id",currentUserId).single();
 if(pe||!p){await rallySupabase.auth.signOut();return false}
 if(p.role==="admin"){state=freshState();Object.assign(state,{loggedIn:true,username:p.username,team:null,role:"admin",phase:"admin"});dbReady=true;return true}
 if(!p.team){await rallySupabase.auth.signOut();return false}
 const [st,qs,tp,sp,ta]=await Promise.all([
  rallySupabase.from("stations").select("station_index,name,latitude,longitude,radius_m,clue_a,clue_b,hint_a,hint_b").order("station_index"),
  rallySupabase.from("route_questions").select("*"),
  rallySupabase.from("team_progress").select("*").eq("team",p.team).single(),
  rallySupabase.from("station_progress").select("*").eq("team",p.team),
  rallySupabase.from("team_answers").select("*").eq("team",p.team)
 ]);
 if(st.error)throw st.error;if(qs.error)throw qs.error;if(tp.error)throw tp.error;if(sp.error)throw sp.error;if(ta.error)throw ta.error;
 for(const r of st.data||[]){if(!TARGETS[r.station_index])TARGETS[r.station_index]={};Object.assign(TARGETS[r.station_index],{name:r.name,lat:r.latitude,lon:r.longitude,radius:r.radius_m,questionA:r.clue_a,questionB:r.clue_b,hintA:r.hint_a,hintB:r.hint_b})}
 routeQuestions={};for(const q of qs.data||[])routeQuestions[q.from_station_index]=q;
 teamAnswers={};for(const a of ta.data||[])teamAnswers[a.from_station_index]=a;
 const x=tp.data;state=freshState();Object.assign(state,{loggedIn:true,username:p.username,team:p.team,role:p.role||"player",step:x.finished?TARGETS.length:x.current_station,hints:x.hints||0,attempts:x.attempts||0,phase:x.finished?"finished":(x.phase||"question"),branchFromStation:x.branch_from_station,correctAnswers:x.correct_answers||0,penaltyPoints:x.penalty_points||0});
 for(const r of sp.data||[]){if(r.completed)state.passed[r.station_index]=true;if(r.hint_used)state["hint_"+p.team+"_"+r.station_index]=true}
 localStorage.setItem(KEY,JSON.stringify(state));dbReady=true;return true;
}

async function persistTeam(){
 if(!dbReady||!state.loggedIn)return;
 const finished=state.phase==="finished"||state.step>=TARGETS.length;
 await rallySupabase.from("team_progress").update({current_station:finished?TARGETS.length:state.step,hints:state.hints,attempts:state.attempts,finished,phase:finished?"finished":state.phase,branch_from_station:null,correct_answers:state.correctAnswers,detours:0,penalty_points:state.penaltyPoints,updated_at:new Date().toISOString()}).eq("team",state.team);
}
function saveLocal(){localStorage.setItem(KEY,JSON.stringify(state));void persistTeam()}
async function persistStation(i){
 const {data:e}=await rallySupabase.from("station_progress").select("*").eq("team",state.team).eq("station_index",i).maybeSingle();
 await rallySupabase.from("station_progress").upsert({team:state.team,station_index:i,attempts:e?.attempts||0,hint_used:e?.hint_used||!!state["hint_"+state.team+"_"+i],completed:e?.completed||!!state.passed[i],completed_at:e?.completed_at||(state.passed[i]?new Date().toISOString():null),updated_at:new Date().toISOString()},{onConflict:"team,station_index"});
}
async function incrementAttempt(i){
 state.attempts++;saveLocal();
 const {data:e}=await rallySupabase.from("station_progress").select("*").eq("team",state.team).eq("station_index",i).maybeSingle();
 await rallySupabase.from("station_progress").upsert({team:state.team,station_index:i,attempts:(e?.attempts||0)+1,hint_used:e?.hint_used||!!state["hint_"+state.team+"_"+i],completed:e?.completed||false,completed_at:e?.completed_at||null,updated_at:new Date().toISOString()},{onConflict:"team,station_index"});
}
async function saveRiddleProgress(from,answerText,wrongAttempts,solved,penaltyPoints,hintShown){
 const row={
   team:state.team,
   from_station_index:from,
   selected_option:null,
   answer_correct:solved,
   detour_completed:false,
   answer_text:answerText||null,
   wrong_attempts:wrongAttempts,
   solved,
   penalty_points:penaltyPoints,
   hint_shown:hintShown,
   answered_at:new Date().toISOString(),
   updated_at:new Date().toISOString()
 };
 const {error}=await rallySupabase.from("team_answers").upsert(row,{onConflict:"team,from_station_index"});
 if(error){console.error("riddle progress save failed",error);return false}
 teamAnswers[from]=row;
 return true;
}

function normalizeAnswer(v){
 return String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9äöüß ]/gi," ").replace(/\s+/g," ").trim();
}
function answerMatches(q,value){
 const a=normalizeAnswer(value);
 return (q.accepted_answers||[]).some(x=>{
   const key=normalizeAnswer(x);
   return a===key || a.includes(key);
 });
}
function advanceAfterRiddle(q){
 state.step=q.correct_target_index;
 state.phase="travel-main";
 state.branchFromStation=null;
 saveLocal();
 renderLive();
}


async function consumeRemoteBypass(){
 const {data,error}=await rallySupabase.rpc("consume_gps_bypass");
 if(error){console.error("gps bypass check failed",error);return false}
 return data===true;
}
function phaseLabel(p){
 const labels={question:"Rätsel", "travel-main":"Unterwegs zum Ziel",finished:"Fertig"};
 return labels[p]||p||"Unbekannt";
}
async function loadAdminData(){
 const [progress,controls,answers]=await Promise.all([
   rallySupabase.from("team_progress").select("team,current_station,hints,attempts,finished,phase,correct_answers,penalty_points,updated_at").order("team"),
   rallySupabase.from("admin_controls").select("team,gps_bypass_once,updated_at").order("team"),
   rallySupabase.from("team_answers").select("team,from_station_index,solved,wrong_attempts,penalty_points,hint_shown")
 ]);
 if(progress.error)throw progress.error;if(controls.error)throw controls.error;if(answers.error)throw answers.error;
 return {progress:progress.data||[],controls:controls.data||[],answers:answers.data||[]};
}
async function setGpsBypass(team,enabled){
 const {error}=await rallySupabase.from("admin_controls").update({gps_bypass_once:enabled,updated_at:new Date().toISOString()}).eq("team",team);
 if(error){alert("Freigabe konnte nicht gesetzt werden.");console.error(error);return}
 await renderAdminDashboard();
}

async function resetTeamProgress(team){
 if(!confirm("Fortschritt von Team "+team+" wirklich komplett zurücksetzen?")) return;

 const [a,b,c1,d] = await Promise.all([
   rallySupabase.from("team_answers").delete().eq("team",team),
   rallySupabase.from("station_progress").delete().eq("team",team),
   rallySupabase.from("admin_controls").update({gps_bypass_once:false,updated_at:new Date().toISOString()}).eq("team",team),
   rallySupabase.from("team_progress").update({
     current_station:0,
     hints:0,
     attempts:0,
     finished:false,
     phase:"question",
     branch_from_station:null,
     correct_answers:0,
     detours:0,
     penalty_points:0,
     updated_at:new Date().toISOString()
   }).eq("team",team)
 ]);

 const err=a.error||b.error||c1.error||d.error;
 if(err){alert("Zurücksetzen fehlgeschlagen.");console.error(err);return}
 alert("Team "+team+" wurde auf Frage 1 zurückgesetzt.");
 await renderAdminDashboard();
}
async function renderAdminDashboard(){
 const app=document.getElementById("app");
 app.innerHTML='<section class="card"><h1>🛰️ Orga-Dashboard</h1><div class="status info">Live-Daten werden geladen …</div></section>';
 try{
   const data=await loadAdminData();
   const controlMap=Object.fromEntries(data.controls.map(x=>[x.team,x]));
   const cards=data.progress.map(p=>{
     const ctrl=controlMap[p.team]||{};
     const answered=data.answers.filter(a=>a.team===p.team);
     const right=answered.filter(a=>a.solved).length;
     const stationText=p.finished?"Ziel erreicht":(p.current_station+1)+" / "+TARGETS.length;
     return `<div class="mission">
       <div class="row" style="justify-content:space-between;align-items:center">
         <h2 style="margin:0">Team ${escapeHtml(p.team)}</h2>
         <span class="badge">${escapeHtml(phaseLabel(p.phase))}</span>
       </div>
       <p><strong>Fortschritt:</strong> ${stationText}<br>
       <strong>Richtige Antworten:</strong> ${right}<br>
       <strong>Strafpunkte:</strong> ${p.penalty_points||0}<br>
       <strong>Hinweise:</strong> ${p.hints||0}<br>
       <strong>GPS-Prüfungen:</strong> ${p.attempts||0}</p>
       <div class="status ${ctrl.gps_bypass_once?"ok":"info"}">
         ${ctrl.gps_bypass_once?"✅ Nächster GPS-Check wird automatisch akzeptiert.":"GPS-Notfallfreigabe ist aus."}
       </div>
       <div class="row" style="margin-top:12px">
         <button class="${ctrl.gps_bypass_once?"ghost":"warn"} adminBypassBtn" data-team="${p.team}" data-enabled="${ctrl.gps_bypass_once?"false":"true"}">
           ${ctrl.gps_bypass_once?"Freigabe zurücknehmen":"📍 Nächsten GPS-Check freigeben"}
         </button>
         <button class="danger adminResetBtn" data-team="${p.team}">↺ Fortschritt zurücksetzen</button>
       </div>
       <p class="small">Letztes Update: ${p.updated_at?new Date(p.updated_at).toLocaleString("de-DE"):"-"}</p>
     </div>`;
   }).join("");
   app.innerHTML=`<section class="card">
     <span class="badge">Admin</span><h1>🛰️ Orga-Dashboard</h1>
     <p>Hier siehst du beide Teams live und kannst bei GPS-Problemen genau den nächsten Standort-Check freigeben.</p>
     ${cards}
     <div class="row"><button class="secondary" id="adminRefreshBtn">↻ Aktualisieren</button><button class="ghost" id="logoutBtn">Abmelden</button></div>
   </section>`;
   document.querySelectorAll(".adminBypassBtn").forEach(b=>b.addEventListener("click",()=>setGpsBypass(b.dataset.team,b.dataset.enabled==="true")));
   document.querySelectorAll(".adminResetBtn").forEach(b=>b.addEventListener("click",()=>resetTeamProgress(b.dataset.team)));
   document.getElementById("adminRefreshBtn").addEventListener("click",renderAdminDashboard);
   document.getElementById("logoutBtn").addEventListener("click",logoutLive);
 }catch(e){console.error(e);app.innerHTML='<section class="card"><h1>⚠️ Orga-Dashboard</h1><div class="status bad">Dashboard konnte nicht geladen werden.</div><button class="ghost" id="logoutBtn">Abmelden</button></section>';document.getElementById("logoutBtn").addEventListener("click",logoutLive)}
}
function renderLoginLive(){return `<section class="card"><span class="badge">Live mit Datenbank</span><h1>🌲 Hannover City Challenge</h1><p>Knobeln, Ziel finden, Hannover entdecken.</p><div class="mission"><strong>Startpunkt</strong><p>${START.text}</p></div><label for="username">Benutzername</label><input id="username" autocomplete="username" placeholder="team-a"><label for="password">Passwort</label><input id="password" type="password" autocomplete="current-password" placeholder="Passwort"><div class="row" style="margin-top:14px"><button class="primary" id="loginBtn">Einloggen</button></div><div id="loginStatus" class="status info">🔐 Supabase-Login aktiv</div></section>`}
function renderQuestion(){
 const k=questionKey(),q=routeQuestions[k];
 if(!q)return `<section class="card"><h1>⚠️ Rätsel fehlt</h1><p>Für diese Etappe ist noch kein Rätsel hinterlegt.</p></section>`;
 const saved=teamAnswers[k]||{};
 const wrong=saved.wrong_attempts||0;
 const forced=wrong>=3&&!saved.solved;
 const hintVisible=wrong>=2;
 return `<section class="card">
   <span class="badge">Team ${state.team}</span>
   <span class="badge">Rätsel ${state.step+1}/${TARGETS.length-1}</span>
   <span class="badge">⚠️ ${state.penaltyPoints} Strafpunkt${state.penaltyPoints===1?"":"e"}</span>
   <h1>🧩 Rätselgeschichte</h1>
   <div class="mission">
     <h3>📍 Hannover-Fakt</h3>
     <p>${escapeHtml(q.fun_fact||"")}</p>
   </div>
   <div class="mission">
     <h3>Der Fall</h3>
     <p>${escapeHtml(q.question)}</p>
   </div>
   ${forced?`
     <div class="status bad"><strong>Auflösung</strong><br>${escapeHtml(q.solution_text||"")}</div>
     <p class="small">Dafür gibt es 1 Strafpunkt. Die Route bleibt unverändert.</p>
     <button class="secondary" id="riddleContinueBtn">Nächstes Ziel →</button>
   `:`
     <label for="riddleAnswer">Eure Lösung</label>
     <input id="riddleAnswer" autocomplete="off" placeholder="Schreibt eure Theorie …" value="${escapeHtml(saved.answer_text||"")}">
     <div class="row" style="margin-top:12px"><button class="primary" id="riddleSubmitBtn">Lösung prüfen</button></div>
     <div id="riddleStatus" class="status info">${wrong? `Bisherige Fehlversuche: <strong>${wrong}</strong>` : "Diskutiert gemeinsam und gebt eure Lösung ein."}</div>
     ${hintVisible?`<div class="status info">💡 <strong>Hinweis:</strong> ${escapeHtml(q.hint_text||"")}</div>`:""}
   `}
 </section>`;
}
function renderTravelMain(){
 const t=TARGETS[state.step],hintUsed=!!state["hint_"+state.team+"_"+state.step];
 return `<section class="card"><span class="badge">Team ${state.team}</span><span class="badge">Ziel ${state.step+1}/${TARGETS.length}</span><span class="badge">✅ ${state.correctAnswers}</span><span class="badge">⚠️ ${state.penaltyPoints}</span><h1>🧭 Euer Ziel</h1><div class="mission"><p>${questionForTeam(t)}</p></div><button class="primary" id="checkBtn">📍 Standort prüfen</button><div id="status" class="status info">Lauft zum vermuteten Ziel und prüft dort euren Standort.</div><div class="row" style="margin-top:12px"><button class="warn" id="hintBtn">💡 Hinweis</button></div><div id="hintBox" class="status ${hintUsed?"":"hidden"}">${hintUsed?"💡 "+hintForTeam(t):""}</div><details><summary>🧪 Testmodus</summary><label style="display:flex;gap:10px;align-items:center;margin-top:12px"><input id="demoMode" type="checkbox" style="width:auto" ${state.demoMode?"checked":""}><span>GPS-Treffer simulieren</span></label><label style="display:flex;gap:10px;align-items:center"><input id="simulateWrong" type="checkbox" style="width:auto" ${state.simulateWrong?"checked":""}><span>GPS absichtlich als falsch simulieren</span></label></details><hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}

function renderFinishedLive(){return `<section class="card"><span class="badge">Team ${state.team}</span><h1>🏁 Geschafft!</h1><p class="big">Ihr seid am Vietal angekommen.</p><div class="mission"><p>🧠 Richtige Antworten: <strong>${state.correctAnswers}</strong></p><p>⚠️ Strafpunkte: <strong>${state.penaltyPoints}</strong></p><p>💡 Hinweise: <strong>${state.hints}</strong></p><p>📍 Standortprüfungen: <strong>${state.attempts}</strong></p></div><button class="ghost" id="logoutBtn">Abmelden</button></section>`}

async function loginLive(){
 const u=document.getElementById("username").value.trim().toLowerCase(),p=document.getElementById("password").value,b=document.getElementById("loginStatus");
 if(!u||!p){b.className="status bad";b.innerHTML="<strong>❌ Benutzername und Passwort eingeben.</strong>";return}
 b.className="status info";b.textContent="🔐 Anmeldung läuft …";
 const {error}=await rallySupabase.auth.signInWithPassword({email:u+"@"+rallyConfig.loginDomain,password:p});
 if(error){b.className="status bad";b.innerHTML="<strong>❌ Login fehlgeschlagen.</strong>";return}
 try{if(!await loadGame())throw new Error("Kein Teamprofil");renderLive()}catch(e){console.error(e);b.className="status bad";b.innerHTML="<strong>❌ Spielstand konnte nicht geladen werden.</strong>"}
}
async function logoutLive(){await rallySupabase.auth.signOut();dbReady=false;currentUserId=null;routeQuestions={};teamAnswers={};localStorage.removeItem(KEY);state=freshState();renderLive()}
function useHintLive(){const k="hint_"+state.team+"_"+state.step;if(!state[k]){state[k]=true;state.hints++;saveLocal();void persistStation(state.step)}renderLive()}
function getGps(cb){
 if(state.demoMode){setTimeout(()=>cb(!state.simulateWrong),200);return}
 if(!navigator.geolocation){cb(false,"Standortabfrage wird nicht unterstützt.");return}
 navigator.geolocation.getCurrentPosition(p=>cb(p),e=>{let m="Standort konnte nicht geprüft werden.";if(e.code===1)m="Standortfreigabe wurde abgelehnt.";if(e.code===2)m="Standort ist momentan nicht verfügbar.";if(e.code===3)m="Standortabfrage hat zu lange gedauert.";cb(false,m)},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
}
function atPos(r,lat,lon,radius){if(r===true)return true;if(!r?.coords)return false;const d=distanceMeters(r.coords.latitude,r.coords.longitude,lat,lon);return d<=Math.max(radius,Math.min(110,r.coords.accuracy||0))}
async function submitRiddle(){
 const input=document.getElementById("riddleAnswer");
 const status=document.getElementById("riddleStatus");
 const from=questionKey(),q=routeQuestions[from];
 const value=input.value.trim();
 if(!value){status.className="status bad";status.textContent="Schreibt erst eine Lösung hinein.";return}

 const existing=teamAnswers[from]||{};
 if(answerMatches(q,value)){
   await saveRiddleProgress(from,value,existing.wrong_attempts||0,true,existing.penalty_points||0,existing.hint_shown||false);
   state.correctAnswers++;
   saveLocal();
   advanceAfterRiddle(q);
   return;
 }

 const wrong=(existing.wrong_attempts||0)+1;
 const forced=wrong>=3;
 const penalty=forced?1:(existing.penalty_points||0);
 await saveRiddleProgress(from,value,wrong,false,penalty,wrong>=2);

 if(forced){
   state.penaltyPoints++;
   saveLocal();
   renderLive();
   return;
 }

 status.className="status bad";
 status.innerHTML=wrong===1?"<strong>❌ Das erklärt noch nicht alle Hinweise.</strong><br>Diskutiert noch einmal.":"<strong>❌ Noch nicht.</strong><br>Ihr bekommt jetzt einen Hinweis.";
 if(wrong>=2)renderLive();
}
async function checkMainLocation(){
 const i=state.step,t=TARGETS[i],btn=document.getElementById("checkBtn"),s=document.getElementById("status");btn.disabled=true;s.className="status info";s.textContent="📡 Standort wird geprüft …";await incrementAttempt(i);
 const bypass=await consumeRemoteBypass();
 if(bypass){state.passed[i]=true;await persistStation(i);if(i===TARGETS.length-1){state.step=TARGETS.length;state.phase="finished"}else{state.step=i+1;state.phase=routeQuestions[i]?"question":"travel-main"}state.branchFromStation=null;saveLocal();renderLive();return}
 getGps(async(r,m)=>{if(!atPos(r,t.lat,t.lon,t.radius)){s.className="status bad";s.innerHTML="<strong>❌ Noch nicht richtig.</strong><br>"+(m||"Weiter suchen.");btn.disabled=false;return}
 state.passed[i]=true;await persistStation(i);
 if(i===TARGETS.length-1){state.step=TARGETS.length;state.phase="finished"}else{state.step=i+1;state.phase="question"}
 state.branchFromStation=null;saveLocal();renderLive();
 });
}

function wireDemo(){const a=document.getElementById("demoMode"),b=document.getElementById("simulateWrong");if(a)a.addEventListener("change",e=>{state.demoMode=e.target.checked;localStorage.setItem(KEY,JSON.stringify(state))});if(b)b.addEventListener("change",e=>{state.simulateWrong=e.target.checked;localStorage.setItem(KEY,JSON.stringify(state))})}
function renderLive(){
 const app=document.getElementById("app");
 if(!state.loggedIn){app.innerHTML=renderLoginLive();document.getElementById("loginBtn").addEventListener("click",loginLive);document.getElementById("password").addEventListener("keydown",e=>{if(e.key==="Enter")loginLive()});return}
 if(state.role==="admin"){void renderAdminDashboard();return}
 if(state.phase==="finished"||state.step>=TARGETS.length){app.innerHTML=renderFinishedLive();document.getElementById("logoutBtn").addEventListener("click",logoutLive);return}
 if(state.phase==="question"){app.innerHTML=renderQuestion();const submit=document.getElementById("riddleSubmitBtn");if(submit){submit.addEventListener("click",submitRiddle);document.getElementById("riddleAnswer").addEventListener("keydown",e=>{if(e.key==="Enter")submitRiddle()})}const cont=document.getElementById("riddleContinueBtn");if(cont)cont.addEventListener("click",()=>advanceAfterRiddle(routeQuestions[questionKey()]));return}
 app.innerHTML=renderTravelMain();document.getElementById("checkBtn").addEventListener("click",checkMainLocation);document.getElementById("hintBtn").addEventListener("click",useHintLive);document.getElementById("logoutBtn").addEventListener("click",logoutLive);wireDemo();
}
window.render=renderLive;window.login=loginLive;window.resetAll=logoutLive;
(async()=>{state=freshState();try{await loadGame()}catch(e){console.error(e);await rallySupabase.auth.signOut();state=freshState()}renderLive()})();
