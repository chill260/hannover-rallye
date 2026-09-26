const rallyConfig=window.RALLYE_CONFIG||{};
const rallySupabase=window.supabase.createClient(rallyConfig.supabaseUrl,rallyConfig.supabasePublishableKey);
let dbReady=false,currentUserId=null,routeQuestions={},teamAnswers={};

function freshState(){return{loggedIn:false,username:null,team:null,step:0,hints:0,attempts:0,passed:{},phase:"question",branchFromStation:null,correctAnswers:0,detours:0,demoMode:false,simulateWrong:false}}
function escapeHtml(v){return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function questionKey(){return state.step===0?-1:state.step-1}
function questionForTeam(t){return state.team==="A"?t.questionA:t.questionB}
function hintForTeam(t){return state.team==="A"?t.hintA:t.hintB}

async function loadGame(){
 const {data:s}=await rallySupabase.auth.getSession(); if(!s?.session)return false;
 currentUserId=s.session.user.id;
 const {data:p,error:pe}=await rallySupabase.from("profiles").select("username,team,role").eq("id",currentUserId).single();
 if(pe||!p?.team){await rallySupabase.auth.signOut();return false}
 const [st,qs,tp,sp,ta]=await Promise.all([
  rallySupabase.from("stations").select("station_index,name,latitude,longitude,radius_m").order("station_index"),
  rallySupabase.from("route_questions").select("*"),
  rallySupabase.from("team_progress").select("*").eq("team",p.team).single(),
  rallySupabase.from("station_progress").select("*").eq("team",p.team),
  rallySupabase.from("team_answers").select("*").eq("team",p.team)
 ]);
 if(st.error)throw st.error;if(qs.error)throw qs.error;if(tp.error)throw tp.error;if(sp.error)throw sp.error;if(ta.error)throw ta.error;
 for(const r of st.data||[]){if(TARGETS[r.station_index]){Object.assign(TARGETS[r.station_index],{name:r.name,lat:r.latitude,lon:r.longitude,radius:r.radius_m})}}
 routeQuestions={};for(const q of qs.data||[])routeQuestions[q.from_station_index]=q;
 teamAnswers={};for(const a of ta.data||[])teamAnswers[a.from_station_index]=a;
 const x=tp.data;state=freshState();Object.assign(state,{loggedIn:true,username:p.username,team:p.team,step:x.finished?TARGETS.length:x.current_station,hints:x.hints||0,attempts:x.attempts||0,phase:x.finished?"finished":(x.phase||"question"),branchFromStation:x.branch_from_station,correctAnswers:x.correct_answers||0,detours:x.detours||0});
 for(const r of sp.data||[]){if(r.completed)state.passed[r.station_index]=true;if(r.hint_used)state["hint_"+p.team+"_"+r.station_index]=true}
 localStorage.setItem(KEY,JSON.stringify(state));dbReady=true;return true;
}

async function persistTeam(){
 if(!dbReady||!state.loggedIn)return;
 const finished=state.phase==="finished"||state.step>=TARGETS.length;
 await rallySupabase.from("team_progress").update({current_station:finished?TARGETS.length:state.step,hints:state.hints,attempts:state.attempts,finished,phase:finished?"finished":state.phase,branch_from_station:state.branchFromStation,correct_answers:state.correctAnswers,detours:state.detours,updated_at:new Date().toISOString()}).eq("team",state.team);
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
async function persistAnswer(from,sel,correct){
 const row={team:state.team,from_station_index:from,selected_option:sel,answer_correct:correct,detour_completed:false,answered_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 await rallySupabase.from("team_answers").upsert(row,{onConflict:"team,from_station_index"});teamAnswers[from]=row;
}
async function markDetourComplete(from){
 const e=teamAnswers[from];if(!e)return;
 const row={...e,detour_completed:true,updated_at:new Date().toISOString()};
 await rallySupabase.from("team_answers").upsert(row,{onConflict:"team,from_station_index"});teamAnswers[from]=row;
}

function renderLoginLive(){return `<section class="card"><span class="badge">Live mit Datenbank</span><h1>🌲 Hannover City Challenge</h1><p>Frage beantworten, Ziel bekommen, hinlaufen, GPS prüfen.</p><div class="mission"><strong>Startpunkt</strong><p>${START.text}</p></div><label for="username">Benutzername</label><input id="username" autocomplete="username" placeholder="team-a"><label for="password">Passwort</label><input id="password" type="password" autocomplete="current-password" placeholder="Passwort"><div class="row" style="margin-top:14px"><button class="primary" id="loginBtn">Einloggen</button></div><div id="loginStatus" class="status info">🔐 Supabase-Login aktiv</div></section>`}
function renderQuestion(){
 const k=questionKey(),q=routeQuestions[k];if(!q)return `<section class="card"><h1>⚠️ Frage fehlt</h1><p>Für diese Etappe ist noch keine Frage hinterlegt.</p></section>`;
 const opts=Array.isArray(q.options)?q.options:[];
 return `<section class="card"><span class="badge">Team ${state.team}</span><span class="badge">Frage ${state.step+1}/${TARGETS.length}</span><h1>🧠 Wohin geht es weiter?</h1><div class="mission"><h3>Frage</h3><p>${escapeHtml(q.question)}</p></div><div style="display:grid;gap:10px">${opts.map((o,i)=>`<button class="ghost answerBtn" data-answer="${i}">${String.fromCharCode(65+i)} · ${escapeHtml(o)}</button>`).join("")}</div><p class="small">Eure Antwort bestimmt den nächsten Standort. Ob sie richtig war, erfahrt ihr erst am Ziel.</p></section>`;
}
function renderTravelMain(){
 const t=TARGETS[state.step],hintUsed=!!state["hint_"+state.team+"_"+state.step];
 return `<section class="card"><span class="badge">Team ${state.team}</span><span class="badge">Ziel ${state.step+1}/${TARGETS.length}</span><span class="badge">✅ ${state.correctAnswers}</span><span class="badge">↪️ ${state.detours}</span><h1>🧭 Euer Ziel</h1><div class="mission"><p>${questionForTeam(t)}</p></div><button class="primary" id="checkBtn">📍 Standort prüfen</button><div id="status" class="status info">Lauft zum vermuteten Ziel und prüft dort euren Standort.</div><div class="row" style="margin-top:12px"><button class="warn" id="hintBtn">💡 Hinweis</button></div><div id="hintBox" class="status ${hintUsed?"":"hidden"}">${hintUsed?"💡 "+hintForTeam(t):""}</div><details><summary>🧪 Testmodus</summary><label style="display:flex;gap:10px;align-items:center;margin-top:12px"><input id="demoMode" type="checkbox" style="width:auto" ${state.demoMode?"checked":""}><span>GPS-Treffer simulieren</span></label><label style="display:flex;gap:10px;align-items:center"><input id="simulateWrong" type="checkbox" style="width:auto" ${state.simulateWrong?"checked":""}><span>GPS absichtlich als falsch simulieren</span></label></details><hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}
function renderTravelDecoy(){
 const q=routeQuestions[state.branchFromStation];
 return `<section class="card"><span class="badge">Team ${state.team}</span><span class="badge">Antwort abgegeben</span><h1>🧭 Euer Ziel</h1><div class="mission"><p>Findet jetzt:</p><p class="big">📍 ${escapeHtml(q.decoy_name)}</p><p class="small">Ob eure Antwort richtig war, erfahrt ihr erst dort.</p></div><button class="primary" id="checkDecoyBtn">📍 Standort prüfen</button><div id="status" class="status info">Noch wird nichts verraten. 😈</div><details><summary>🧪 Testmodus</summary><label style="display:flex;gap:10px;align-items:center;margin-top:12px"><input id="demoMode" type="checkbox" style="width:auto" ${state.demoMode?"checked":""}><span>GPS-Treffer simulieren</span></label><label style="display:flex;gap:10px;align-items:center"><input id="simulateWrong" type="checkbox" style="width:auto" ${state.simulateWrong?"checked":""}><span>GPS absichtlich als falsch simulieren</span></label></details></section>`;
}
function renderDetourReveal(){
 const q=routeQuestions[state.branchFromStation],t=TARGETS[state.step];
 return `<section class="card"><span class="badge">Ehrenrunde beendet</span><h1>❌ Antwort leider falsch</h1><div class="status bad">${escapeHtml(q.wrong_reveal)}</div><div class="mission"><p>Jetzt geht es zum richtigen Ziel:</p><p class="big">📍 ${escapeHtml(t.name)}</p><p>Findet den Ort und prüft dort erneut euren Standort.</p></div><button class="secondary" id="continueFromDetourBtn">Zum richtigen Ziel →</button></section>`;
}
function renderFinishedLive(){return `<section class="card"><span class="badge">Team ${state.team}</span><h1>🏁 Geschafft!</h1><p class="big">Ihr seid am Vietal angekommen.</p><div class="mission"><p>🧠 Richtige Antworten: <strong>${state.correctAnswers}</strong></p><p>↪️ Ehrenrunden: <strong>${state.detours}</strong></p><p>💡 Hinweise: <strong>${state.hints}</strong></p><p>📍 Standortprüfungen: <strong>${state.attempts}</strong></p></div><button class="ghost" id="logoutBtn">Abmelden</button></section>`}

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
async function answerQuestion(sel){
 const from=questionKey(),q=routeQuestions[from],correct=sel===q.correct_option;
 await persistAnswer(from,sel,correct);state.step=q.correct_target_index;
 if(correct){state.correctAnswers++;state.phase="travel-main";state.branchFromStation=null}else{state.detours++;state.phase="travel-decoy";state.branchFromStation=from}
 saveLocal();renderLive();
}
async function checkMainLocation(){
 const i=state.step,t=TARGETS[i],btn=document.getElementById("checkBtn"),s=document.getElementById("status");btn.disabled=true;s.className="status info";s.textContent="📡 Standort wird geprüft …";await incrementAttempt(i);
 getGps(async(r,m)=>{if(!atPos(r,t.lat,t.lon,t.radius)){s.className="status bad";s.innerHTML="<strong>❌ Noch nicht richtig.</strong><br>"+(m||"Weiter suchen.");btn.disabled=false;return}
 state.passed[i]=true;await persistStation(i);
 if(i===TARGETS.length-1){state.step=TARGETS.length;state.phase="finished"}else{state.step=i+1;state.phase="question"}
 state.branchFromStation=null;saveLocal();renderLive();
 });
}
async function checkDecoyLocation(){
 const from=state.branchFromStation,q=routeQuestions[from],btn=document.getElementById("checkDecoyBtn"),s=document.getElementById("status");btn.disabled=true;s.className="status info";s.textContent="📡 Standort wird geprüft …";state.attempts++;saveLocal();
 getGps(async(r,m)=>{if(!atPos(r,q.decoy_latitude,q.decoy_longitude,q.decoy_radius_m)){s.className="status bad";s.innerHTML="<strong>❌ Noch nicht am zugeteilten Ziel.</strong><br>"+(m||"Weiter suchen.");btn.disabled=false;return}await markDetourComplete(from);state.phase="detour-reveal";saveLocal();renderLive()});
}
function continueFromDetour(){state.phase="travel-main";saveLocal();renderLive()}
function wireDemo(){const a=document.getElementById("demoMode"),b=document.getElementById("simulateWrong");if(a)a.addEventListener("change",e=>{state.demoMode=e.target.checked;localStorage.setItem(KEY,JSON.stringify(state))});if(b)b.addEventListener("change",e=>{state.simulateWrong=e.target.checked;localStorage.setItem(KEY,JSON.stringify(state))})}
function renderLive(){
 const app=document.getElementById("app");
 if(!state.loggedIn){app.innerHTML=renderLoginLive();document.getElementById("loginBtn").addEventListener("click",loginLive);document.getElementById("password").addEventListener("keydown",e=>{if(e.key==="Enter")loginLive()});return}
 if(state.phase==="finished"||state.step>=TARGETS.length){app.innerHTML=renderFinishedLive();document.getElementById("logoutBtn").addEventListener("click",logoutLive);return}
 if(state.phase==="question"){app.innerHTML=renderQuestion();document.querySelectorAll(".answerBtn").forEach(b=>b.addEventListener("click",()=>answerQuestion(Number(b.dataset.answer))));return}
 if(state.phase==="travel-decoy"){app.innerHTML=renderTravelDecoy();document.getElementById("checkDecoyBtn").addEventListener("click",checkDecoyLocation);wireDemo();return}
 if(state.phase==="detour-reveal"){app.innerHTML=renderDetourReveal();document.getElementById("continueFromDetourBtn").addEventListener("click",continueFromDetour);return}
 app.innerHTML=renderTravelMain();document.getElementById("checkBtn").addEventListener("click",checkMainLocation);document.getElementById("hintBtn").addEventListener("click",useHintLive);document.getElementById("logoutBtn").addEventListener("click",logoutLive);wireDemo();
}
window.render=renderLive;window.login=loginLive;window.resetAll=logoutLive;
(async()=>{state=freshState();try{await loadGame()}catch(e){console.error(e);await rallySupabase.auth.signOut();state=freshState()}renderLive()})();
