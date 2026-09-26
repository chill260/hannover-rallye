const rallyConfig=window.RALLYE_CONFIG||{};
const rallySupabase=window.supabase.createClient(rallyConfig.supabaseUrl,rallyConfig.supabasePublishableKey);
let dbReady=false,currentUserId=null,routeQuestions={},teamAnswers={},adminTab="teams",adminEditorMap=null,adminEditorMarker=null;

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

async function loadAdminRoute(){
 const [stations,questions]=await Promise.all([
   rallySupabase.from("stations").select("*").order("station_index"),
   rallySupabase.from("route_questions").select("*").order("from_station_index")
 ]);
 if(stations.error)throw stations.error;if(questions.error)throw questions.error;
 return {stations:stations.data||[],questions:questions.data||[]};
}
function adminShell(title,body){
 return `<section class="card"><span class="badge">Admin</span><h1>🛠️ ${title}</h1>
 <div class="admin-tabs">
   <button class="${adminTab==="teams"?"active ghost":"ghost"}" data-admin-tab="teams">📊 Teams</button>
   <button class="${adminTab==="stations"?"active ghost":"ghost"}" data-admin-tab="stations">📍 Stationen</button>
   <button class="${adminTab==="questions"?"active ghost":"ghost"}" data-admin-tab="questions">🧩 Rätsel</button>
 </div>${body}<hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}
function wireAdminTabs(){
 document.querySelectorAll("[data-admin-tab]").forEach(b=>b.addEventListener("click",()=>{adminTab=b.dataset.adminTab;renderAdminDashboard()}));
 const lo=document.getElementById("logoutBtn");if(lo)lo.addEventListener("click",logoutLive);
}
async function renderAdminTeams(){
 const data=await loadAdminData();
 const controlMap=Object.fromEntries(data.controls.map(x=>[x.team,x]));
 const cards=data.progress.map(p=>{
   const ctrl=controlMap[p.team]||{};
   const answered=data.answers.filter(a=>a.team===p.team);
   const right=answered.filter(a=>a.solved).length;
   const stationText=p.finished?"Ziel erreicht":(p.current_station+1)+" / "+TARGETS.length;
   return `<div class="mission">
     <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Team ${escapeHtml(p.team)}</h2><span class="badge">${escapeHtml(phaseLabel(p.phase))}</span></div>
     <p><strong>Fortschritt:</strong> ${stationText}<br><strong>Gelöste Rätsel:</strong> ${right}<br><strong>Strafpunkte:</strong> ${p.penalty_points||0}<br><strong>Hinweise:</strong> ${p.hints||0}<br><strong>GPS-Prüfungen:</strong> ${p.attempts||0}</p>
     <div class="status ${ctrl.gps_bypass_once?"ok":"info"}">${ctrl.gps_bypass_once?"✅ Nächster GPS-Check wird automatisch akzeptiert.":"GPS-Notfallfreigabe ist aus."}</div>
     <div class="row" style="margin-top:12px">
       <button class="${ctrl.gps_bypass_once?"ghost":"warn"} adminBypassBtn" data-team="${p.team}" data-enabled="${ctrl.gps_bypass_once?"false":"true"}">${ctrl.gps_bypass_once?"Freigabe zurücknehmen":"📍 Nächsten GPS-Check freigeben"}</button>
       <button class="danger adminResetBtn" data-team="${p.team}">↺ Fortschritt zurücksetzen</button>
     </div>
     <p class="small">Letztes Update: ${p.updated_at?new Date(p.updated_at).toLocaleString("de-DE"):"-"}</p>
   </div>`;
 }).join("");
 document.getElementById("app").innerHTML=adminShell("Orga-Dashboard",`<p>Live-Fortschritt und Notfallsteuerung für beide Teams.</p>${cards}<div class="row"><button class="secondary" id="adminRefreshBtn">↻ Aktualisieren</button></div>`);
 wireAdminTabs();
 document.querySelectorAll(".adminBypassBtn").forEach(b=>b.addEventListener("click",()=>setGpsBypass(b.dataset.team,b.dataset.enabled==="true")));
 document.querySelectorAll(".adminResetBtn").forEach(b=>b.addEventListener("click",()=>resetTeamProgress(b.dataset.team)));
 document.getElementById("adminRefreshBtn").addEventListener("click",renderAdminDashboard);
}
function stationForm(s,isNew=false){
 const idx=isNew?"":s.station_index;
 return `<div class="mission">
 <h2>${isNew?"Neue Station":"Station "+(s.station_index+1)}</h2>
 <input type="hidden" id="stationIndex" value="${idx}">
 <label>Name</label><input id="stationName" value="${escapeHtml(s.name||"")}">
 <div class="two-col">
   <div><label>Breitengrad</label><input id="stationLat" type="number" step="0.000001" value="${s.latitude??52.3745}"></div>
   <div><label>Längengrad</label><input id="stationLon" type="number" step="0.000001" value="${s.longitude??9.7385}"></div>
 </div>
 <label>GPS-Radius in Metern</label><input id="stationRadius" type="number" min="20" max="200" value="${s.radius_m??55}">
 <label>Zielhinweis Team A</label><textarea id="stationClueA">${escapeHtml(s.clue_a||"")}</textarea>
 <label>Hinweis Team A</label><textarea id="stationHintA">${escapeHtml(s.hint_a||"")}</textarea>
 <label>Zielhinweis Team B</label><textarea id="stationClueB">${escapeHtml(s.clue_b||"")}</textarea>
 <label>Hinweis Team B</label><textarea id="stationHintB">${escapeHtml(s.hint_b||"")}</textarea>
 <div id="stationMap"></div>
 <div class="row" style="margin-top:12px">
   <button class="secondary" id="useCurrentLocationBtn">📍 Meinen Standort verwenden</button>
   <button class="primary" id="saveStationBtn">💾 Station speichern</button>
   ${!isNew?'<button class="danger" id="deleteStationBtn">Station löschen</button>':""}
 </div><div id="stationEditorStatus" class="status info">Marker verschieben oder direkt in die Karte klicken.</div>
 </div>`;
}
function initStationMap(lat,lon){
 if(adminEditorMap){adminEditorMap.remove();adminEditorMap=null}
 adminEditorMap=L.map("stationMap").setView([lat,lon],16);
 L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(adminEditorMap);
 adminEditorMarker=L.marker([lat,lon],{draggable:true}).addTo(adminEditorMap);
 const sync=ll=>{document.getElementById("stationLat").value=ll.lat.toFixed(6);document.getElementById("stationLon").value=ll.lng.toFixed(6)};
 adminEditorMarker.on("dragend",e=>sync(e.target.getLatLng()));
 adminEditorMap.on("click",e=>{adminEditorMarker.setLatLng(e.latlng);sync(e.latlng)});
}
async function saveStationEditor(){
 const raw=document.getElementById("stationIndex").value;
 const isNew=raw==="";
 const route=await loadAdminRoute();
 const idx=isNew?(route.stations.length?Math.max(...route.stations.map(x=>x.station_index))+1:0):Number(raw);
 const row={
  station_index:idx,name:document.getElementById("stationName").value.trim(),
  latitude:Number(document.getElementById("stationLat").value),longitude:Number(document.getElementById("stationLon").value),
  radius_m:Number(document.getElementById("stationRadius").value),
  clue_a:document.getElementById("stationClueA").value.trim(),hint_a:document.getElementById("stationHintA").value.trim(),
  clue_b:document.getElementById("stationClueB").value.trim(),hint_b:document.getElementById("stationHintB").value.trim()
 };
 if(!row.name||!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude)){alert("Name und gültige Koordinaten fehlen.");return}
 const {error}=await rallySupabase.from("stations").upsert(row,{onConflict:"station_index"});
 if(error){alert("Speichern fehlgeschlagen.");console.error(error);return}
 alert("Station gespeichert.");renderAdminStations(idx);
}
async function deleteStationEditor(idx){
 const route=await loadAdminRoute();
 const max=Math.max(...route.stations.map(x=>x.station_index));
 if(idx!==max){alert("Zur Sicherheit kann aktuell nur die letzte Station gelöscht werden. So bleiben Reihenfolge und Spielstände konsistent.");return}
 if(!confirm("Letzte Station wirklich löschen?"))return;
 await rallySupabase.from("route_questions").delete().eq("correct_target_index",idx);
 const {error}=await rallySupabase.from("stations").delete().eq("station_index",idx);
 if(error){alert("Löschen fehlgeschlagen.");console.error(error);return}
 alert("Station gelöscht.");renderAdminStations();
}
async function renderAdminStations(selected=null){
 const route=await loadAdminRoute();
 const stations=route.stations;
 const current=selected==="new"?{name:"",latitude:52.3745,longitude:9.7385,radius_m:55,clue_a:"",clue_b:"",hint_a:"",hint_b:""}:
   (stations.find(x=>x.station_index===(selected??stations[0]?.station_index))||stations[0]);
 const list=stations.map(s=>`<div class="admin-item ${current&&s.station_index===current.station_index?"active":""}" data-station-select="${s.station_index}"><strong>${s.station_index+1}. ${escapeHtml(s.name)}</strong><br><span class="small">${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)} · ${s.radius_m} m</span></div>`).join("");
 document.getElementById("app").innerHTML=adminShell("Stationseditor",`<p>Standort per Karte, Marker oder aktuellem Handy-GPS setzen.</p><div class="admin-grid"><div class="admin-list">${list}<button class="secondary" id="newStationBtn">＋ Neue Station</button></div>${stationForm(current||{},selected==="new")}</div>`);
 wireAdminTabs();
 document.querySelectorAll("[data-station-select]").forEach(el=>el.addEventListener("click",()=>renderAdminStations(Number(el.dataset.stationSelect))));
 document.getElementById("newStationBtn").addEventListener("click",()=>renderAdminStations("new"));
 document.getElementById("saveStationBtn").addEventListener("click",saveStationEditor);
 const del=document.getElementById("deleteStationBtn");if(del)del.addEventListener("click",()=>deleteStationEditor(Number(document.getElementById("stationIndex").value)));
 document.getElementById("useCurrentLocationBtn").addEventListener("click",()=>{
   navigator.geolocation.getCurrentPosition(p=>{const ll={lat:p.coords.latitude,lng:p.coords.longitude};adminEditorMarker.setLatLng(ll);adminEditorMap.setView(ll,17);document.getElementById("stationLat").value=ll.lat.toFixed(6);document.getElementById("stationLon").value=ll.lng.toFixed(6)},()=>alert("Standort konnte nicht gelesen werden."),{enableHighAccuracy:true,timeout:12000,maximumAge:0});
 });
 const lat=Number(document.getElementById("stationLat").value),lon=Number(document.getElementById("stationLon").value);
 setTimeout(()=>initStationMap(lat,lon),0);
}
function questionForm(q,stations,isNew=false){
 const type=q.question_type||"free_text";
 const opts=Array.isArray(q.options)?q.options:["","",""];
 const targetOptions=stations.map(s=>`<option value="${s.station_index}" ${Number(q.correct_target_index)===s.station_index?"selected":""}>${s.station_index+1}. ${escapeHtml(s.name)}</option>`).join("");
 return `<div class="mission"><h2>${isNew?"Neues Rätsel":"Rätsel nach Station "+(Number(q.from_station_index)+1)}</h2>
 <input type="hidden" id="questionFrom" value="${isNew?"":q.from_station_index}">
 <label>Nach welcher Station?</label><select id="questionFromSelect"><option value="-1" ${Number(q.from_station_index)===-1?"selected":""}>Start bei der VGH</option>${stations.slice(0,-1).map(s=>`<option value="${s.station_index}" ${Number(q.from_station_index)===s.station_index?"selected":""}>Nach ${s.station_index+1}. ${escapeHtml(s.name)}</option>`).join("")}</select>
 <label>Fragetyp</label><select id="questionType"><option value="free_text" ${type==="free_text"?"selected":""}>Freitext-Rätsel</option><option value="multiple_choice" ${type==="multiple_choice"?"selected":""}>Multiple Choice</option></select>
 <label>Fun Fact zum aktuellen Ort</label><textarea id="questionFact">${escapeHtml(q.fun_fact||"")}</textarea>
 <label>Frage / Rätselgeschichte</label><textarea id="questionText">${escapeHtml(q.question||"")}</textarea>
 <div id="freeTextFields" class="${type==="free_text"?"":"hidden"}">
   <label>Akzeptierte Schlüsselbegriffe, einer pro Zeile</label><textarea id="acceptedAnswers">${escapeHtml((q.accepted_answers||[]).join("\n"))}</textarea>
 </div>
 <div id="mcFields" class="${type==="multiple_choice"?"":"hidden"}">
   <label>Antwortmöglichkeiten</label>
   <div id="mcOptionList">${opts.map((o,i)=>`<div class="option-row"><input type="radio" name="correctMc" value="${i}" ${Number(q.correct_option)===i?"checked":""}><input class="mcOption" value="${escapeHtml(o)}"><button class="danger removeMcBtn" type="button">×</button></div>`).join("")}</div>
   <button class="ghost" id="addMcOptionBtn" type="button">＋ Antwort</button>
 </div>
 <label>Hinweis nach zwei Fehlversuchen</label><textarea id="questionHint">${escapeHtml(q.hint_text||"")}</textarea>
 <label>Auflösung</label><textarea id="questionSolution">${escapeHtml(q.solution_text||"")}</textarea>
 <label>Nächstes Ziel bei richtiger/aufgelöster Antwort</label><select id="questionTarget">${targetOptions}</select>
 <div class="row" style="margin-top:12px"><button class="primary" id="saveQuestionBtn">💾 Rätsel speichern</button>${!isNew?'<button class="danger" id="deleteQuestionBtn">Rätsel löschen</button>':""}</div>
 <div class="status info">Die Teams bekommen Änderungen beim nächsten Laden der Etappe.</div></div>`;
}
function wireQuestionType(){
 const type=document.getElementById("questionType");
 const toggle=()=>{document.getElementById("freeTextFields").classList.toggle("hidden",type.value!=="free_text");document.getElementById("mcFields").classList.toggle("hidden",type.value!=="multiple_choice")};
 type.addEventListener("change",toggle);toggle();
 const add=()=>{const list=document.getElementById("mcOptionList"),i=list.children.length,d=document.createElement("div");d.className="option-row";d.innerHTML=`<input type="radio" name="correctMc" value="${i}"><input class="mcOption"><button class="danger removeMcBtn" type="button">×</button>`;list.appendChild(d);wireMcRemove()};
 document.getElementById("addMcOptionBtn").addEventListener("click",add);wireMcRemove();
}
function wireMcRemove(){document.querySelectorAll(".removeMcBtn").forEach(b=>b.onclick=()=>{if(document.querySelectorAll(".mcOption").length<=2){alert("Mindestens zwei Antworten.");return}b.parentElement.remove();document.querySelectorAll('input[name="correctMc"]').forEach((r,i)=>r.value=i)})}
async function saveQuestionEditor(){
 const type=document.getElementById("questionType").value;
 const from=Number(document.getElementById("questionFromSelect").value);
 const target=Number(document.getElementById("questionTarget").value);
 const qtext=document.getElementById("questionText").value.trim();
 if(!qtext){alert("Bitte eine Frage eingeben.");return}
 let options=null,correct=null,accepted=[];
 if(type==="multiple_choice"){
   options=[...document.querySelectorAll(".mcOption")].map(x=>x.value.trim()).filter(Boolean);
   const checked=document.querySelector('input[name="correctMc"]:checked');
   if(options.length<2||!checked){alert("Mindestens zwei Antworten und eine richtige Antwort markieren.");return}
   correct=Number(checked.value);
   if(correct>=options.length){alert("Bitte richtige Antwort erneut markieren.");return}
 }else{
   accepted=document.getElementById("acceptedAnswers").value.split("\n").map(x=>x.trim()).filter(Boolean);
   if(!accepted.length){alert("Mindestens einen akzeptierten Schlüsselbegriff angeben.");return}
 }
 const row={from_station_index:from,question_type:type,question:qtext,options,correct_option:correct,correct_target_index:target,fun_fact:document.getElementById("questionFact").value.trim(),accepted_answers:accepted,hint_text:document.getElementById("questionHint").value.trim(),solution_text:document.getElementById("questionSolution").value.trim()};
 const {error}=await rallySupabase.from("route_questions").upsert(row,{onConflict:"from_station_index"});
 if(error){alert("Speichern fehlgeschlagen.");console.error(error);return}
 alert("Rätsel gespeichert.");renderAdminQuestions(from);
}
async function deleteQuestionEditor(from){if(!confirm("Rätsel wirklich löschen?"))return;const {error}=await rallySupabase.from("route_questions").delete().eq("from_station_index",from);if(error){alert("Löschen fehlgeschlagen.");return}renderAdminQuestions()}
async function renderAdminQuestions(selected=null){
 const route=await loadAdminRoute();
 const qs=route.questions;
 const current=selected==="new"?{from_station_index:-1,question_type:"free_text",question:"",fun_fact:"",accepted_answers:[],hint_text:"",solution_text:"",correct_target_index:0}: (qs.find(q=>q.from_station_index===(selected??qs[0]?.from_station_index))||qs[0]);
 const list=qs.map(q=>`<div class="admin-item ${current&&q.from_station_index===current.from_station_index?"active":""}" data-question-select="${q.from_station_index}"><strong>${q.from_station_index===-1?"Start":"Nach Station "+(q.from_station_index+1)}</strong><br><span class="small">${escapeHtml((q.question||"").slice(0,90))}</span></div>`).join("");
 document.getElementById("app").innerHTML=adminShell("Rätseleditor",`<p>Freitext-Rätsel und Multiple-Choice-Fragen direkt in der Rallye pflegen.</p><div class="admin-grid"><div class="admin-list">${list}<button class="secondary" id="newQuestionBtn">＋ Neues Rätsel</button></div>${questionForm(current||{},route.stations,selected==="new")}</div>`);
 wireAdminTabs();
 document.querySelectorAll("[data-question-select]").forEach(el=>el.addEventListener("click",()=>renderAdminQuestions(Number(el.dataset.questionSelect))));
 document.getElementById("newQuestionBtn").addEventListener("click",()=>renderAdminQuestions("new"));
 document.getElementById("saveQuestionBtn").addEventListener("click",saveQuestionEditor);
 const del=document.getElementById("deleteQuestionBtn");if(del)del.addEventListener("click",()=>deleteQuestionEditor(Number(document.getElementById("questionFrom").value)));
 wireQuestionType();
}
async function renderAdminDashboard(){
 try{
   if(adminTab==="stations")return await renderAdminStations();
   if(adminTab==="questions")return await renderAdminQuestions();
   return await renderAdminTeams();
 }catch(e){
   console.error(e);
   document.getElementById("app").innerHTML=adminShell("Orga-Dashboard",'<div class="status bad">Dashboard konnte nicht geladen werden.</div>');
   wireAdminTabs();
 }
}
function renderLoginLive(){return `<section class="card"><span class="badge">Live mit Datenbank</span><h1>🌲 Hannover City Challenge</h1><p>Knobeln, Ziel finden, Hannover entdecken.</p><div class="mission"><strong>Startpunkt</strong><p>${START.text}</p></div><label for="username">Benutzername</label><input id="username" autocomplete="username" placeholder="team-a"><label for="password">Passwort</label><input id="password" type="password" autocomplete="current-password" placeholder="Passwort"><div class="row" style="margin-top:14px"><button class="primary" id="loginBtn">Einloggen</button></div><div id="loginStatus" class="status info">🔐 Supabase-Login aktiv</div></section>`}
function renderQuestion(){
 const k=questionKey(),q=routeQuestions[k];
 if(!q)return `<section class="card"><h1>⚠️ Rätsel fehlt</h1><p>Für diese Etappe ist noch kein Rätsel hinterlegt.</p></section>`;
 const saved=teamAnswers[k]||{},wrong=saved.wrong_attempts||0,forced=wrong>=3&&!saved.solved,hintVisible=wrong>=2;
 const isMc=q.question_type==="multiple_choice";
 const options=Array.isArray(q.options)?q.options:[];
 return `<section class="card">
   <span class="badge">Team ${state.team}</span><span class="badge">Rätsel ${state.step+1}/${TARGETS.length-1}</span><span class="badge">⚠️ ${state.penaltyPoints} Strafpunkt${state.penaltyPoints===1?"":"e"}</span>
   <h1>${isMc?"🎯 Multiple Choice":"🧩 Rätselgeschichte"}</h1>
   ${q.fun_fact?`<div class="mission"><h3>📍 Hannover-Fakt</h3><p>${escapeHtml(q.fun_fact)}</p></div>`:""}
   <div class="mission"><h3>${isMc?"Frage":"Der Fall"}</h3><p>${escapeHtml(q.question)}</p></div>
   ${forced?`<div class="status bad"><strong>Auflösung</strong><br>${escapeHtml(q.solution_text||"")}</div><p class="small">Dafür gibt es 1 Strafpunkt. Die Route bleibt unverändert.</p><button class="secondary" id="riddleContinueBtn">Nächstes Ziel →</button>`:
   isMc?`<div style="display:grid;gap:10px">${options.map((o,i)=>`<button class="ghost mcPlayAnswerBtn" data-answer="${i}">${String.fromCharCode(65+i)} · ${escapeHtml(o)}</button>`).join("")}</div><div id="riddleStatus" class="status info">${wrong?`Bisherige Fehlversuche: <strong>${wrong}</strong>`:"Wählt gemeinsam eine Antwort."}</div>${hintVisible?`<div class="status info">💡 <strong>Hinweis:</strong> ${escapeHtml(q.hint_text||"")}</div>`:""}`:
   `<label for="riddleAnswer">Eure Lösung</label><input id="riddleAnswer" autocomplete="off" placeholder="Schreibt eure Theorie …" value="${escapeHtml(saved.answer_text||"")}"><div class="row" style="margin-top:12px"><button class="primary" id="riddleSubmitBtn">Lösung prüfen</button></div><div id="riddleStatus" class="status info">${wrong?`Bisherige Fehlversuche: <strong>${wrong}</strong>`:"Diskutiert gemeinsam und gebt eure Lösung ein."}</div>${hintVisible?`<div class="status info">💡 <strong>Hinweis:</strong> ${escapeHtml(q.hint_text||"")}</div>`:""}`}
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
async function handleWrongRiddle(from,q,answerText,selectedOption=null){
 const existing=teamAnswers[from]||{},wrong=(existing.wrong_attempts||0)+1,forced=wrong>=3,penalty=forced?1:(existing.penalty_points||0);
 const row={team:state.team,from_station_index:from,selected_option:selectedOption,answer_correct:false,detour_completed:false,answer_text:answerText||null,wrong_attempts:wrong,solved:false,penalty_points:penalty,hint_shown:wrong>=2,answered_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 const {error}=await rallySupabase.from("team_answers").upsert(row,{onConflict:"team,from_station_index"});if(error){console.error(error);return}teamAnswers[from]=row;
 if(forced){state.penaltyPoints++;saveLocal();renderLive();return}
 renderLive();
}
async function submitRiddle(){
 const input=document.getElementById("riddleAnswer"),from=questionKey(),q=routeQuestions[from],value=input.value.trim();
 if(!value){document.getElementById("riddleStatus").className="status bad";document.getElementById("riddleStatus").textContent="Schreibt erst eine Lösung hinein.";return}
 const existing=teamAnswers[from]||{};
 if(answerMatches(q,value)){await saveRiddleProgress(from,value,existing.wrong_attempts||0,true,existing.penalty_points||0,existing.hint_shown||false);state.correctAnswers++;saveLocal();advanceAfterRiddle(q);return}
 await handleWrongRiddle(from,q,value,null);
}
async function submitMultipleChoice(sel){
 const from=questionKey(),q=routeQuestions[from],existing=teamAnswers[from]||{},correct=Number(sel)===Number(q.correct_option);
 if(correct){
   const row={team:state.team,from_station_index:from,selected_option:Number(sel),answer_correct:true,detour_completed:false,answer_text:null,wrong_attempts:existing.wrong_attempts||0,solved:true,penalty_points:existing.penalty_points||0,hint_shown:existing.hint_shown||false,answered_at:new Date().toISOString(),updated_at:new Date().toISOString()};
   await rallySupabase.from("team_answers").upsert(row,{onConflict:"team,from_station_index"});teamAnswers[from]=row;state.correctAnswers++;saveLocal();advanceAfterRiddle(q);return;
 }
 await handleWrongRiddle(from,q,null,Number(sel));
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
 if(state.phase==="question"){app.innerHTML=renderQuestion();const submit=document.getElementById("riddleSubmitBtn");if(submit){submit.addEventListener("click",submitRiddle);document.getElementById("riddleAnswer").addEventListener("keydown",e=>{if(e.key==="Enter")submitRiddle()})}document.querySelectorAll(".mcPlayAnswerBtn").forEach(b=>b.addEventListener("click",()=>submitMultipleChoice(Number(b.dataset.answer))));const cont=document.getElementById("riddleContinueBtn");if(cont)cont.addEventListener("click",()=>advanceAfterRiddle(routeQuestions[questionKey()]));return}
 app.innerHTML=renderTravelMain();document.getElementById("checkBtn").addEventListener("click",checkMainLocation);document.getElementById("hintBtn").addEventListener("click",useHintLive);document.getElementById("logoutBtn").addEventListener("click",logoutLive);wireDemo();
}
window.render=renderLive;window.login=loginLive;window.resetAll=logoutLive;
(async()=>{state=freshState();try{await loadGame()}catch(e){console.error(e);await rallySupabase.auth.signOut();state=freshState()}renderLive()})();
