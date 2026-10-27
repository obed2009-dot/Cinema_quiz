const $ = s => document.querySelector(s);
const socket = io();
let selfId=null, currentRoom=null, selectedAnswer=null, quizCache=[];
let questionCount=0;
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}
function showPanel(id){["create-panel","join-panel"].forEach(x=>$("#"+x).hidden=x!==id);if(id)$("#"+id).scrollIntoView({behavior:"smooth",block:"start"})}
$("#go-create").onclick=()=>{showPanel("create-panel");if(!questionCount)addQuestion()};
$("#go-join").onclick=()=>{showPanel("join-panel");$("#join-name").focus()};
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>showPanel(null));
function addQuestion(){
  if(questionCount>=30)return toast("Maximum 30 questions per quiz.");
  const n=++questionCount, card=document.createElement("div");card.className="question-card";card.dataset.question=n;
  card.innerHTML=`<div class="question-top"><strong>QUESTION ${n.toString().padStart(2,"0")}</strong><button class="icon-btn remove-question" type="button" aria-label="Remove question">✕</button></div>
  <div class="question-grid"><label class="wide">Question<input class="q-prompt" maxlength="240" placeholder="Who played the lead in…?" required></label>
  <label class="wide">Photo (optional)<input class="q-image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label></div>
  <div class="answer-select">${[0,1,2,3].map((v)=>`<label><input type="radio" name="answer-${n}" value="${v}" ${v===0?"checked":""}><span>Choice ${String.fromCharCode(65+v)}</span><input class="q-choice" data-choice="${v}" maxlength="100" placeholder="Answer ${String.fromCharCode(65+v)}" required></label>`).join("")}</div>`;
  card.querySelector(".remove-question").onclick=()=>{card.remove();renumberQuestions()};
  $("#question-list").append(card);
}
function renumberQuestions(){const cards=[...document.querySelectorAll(".question-card")];questionCount=cards.length;cards.forEach((c,i)=>{c.dataset.question=i+1;c.querySelector(".question-top strong").textContent=`QUESTION ${(i+1).toString().padStart(2,"0")}`;c.querySelectorAll('input[type="radio"]').forEach(r=>r.name=`answer-${i+1}`)})}
$("#add-question").onclick=addQuestion;
$("#create-form").onsubmit=async e=>{
  e.preventDefault();const cards=[...document.querySelectorAll(".question-card")];if(!cards.length)return toast("Add at least one question.");
  const questions=[],form=new FormData();form.append("title",$("#quiz-title").value.trim());
  let imageIndex=0;
  for(const c of cards){
    const choices=[...c.querySelectorAll(".q-choice")].sort((a,b)=>Number(a.dataset.choice)-Number(b.dataset.choice)).map(x=>x.value.trim());
    const answer=Number(c.querySelector('input[type="radio"]:checked')?.value||0);
    const q={prompt:c.querySelector(".q-prompt").value.trim(),choices,answer_index:answer};
    const file=c.querySelector(".q-image").files[0];
    if(file){q.image_upload_index=imageIndex++;form.append("images",file,file.name);}
    questions.push(q);
  }
  form.set("questions",JSON.stringify(questions));
  try{const res=await fetch("/api/quizzes",{method:"POST",body:form});const data=await res.json();if(!res.ok)throw Error(data.error);toast("Quiz saved!");$("#create-form").reset();$("#question-list").innerHTML="";questionCount=0;showPanel(null);loadQuizzes()}
  catch(err){toast(err.message)}
};
async function loadQuizzes(){
  try{const r=await fetch("/api/quizzes"),list=await r.json();quizCache=list;$("#quiz-count").textContent=`${list.length} quiz${list.length===1?"":"zes"}`;
  $("#quiz-library").innerHTML=list.length?list.map(q=>`<article class="quiz-card"><p>COMMUNITY QUIZ</p><h3>${escapeHtml(q.title)}</h3><p>Ready for a new round?</p><button class="btn primary host-quiz" data-id="${q.id}">Host this quiz ↗</button></article>`).join(""):`<div class="notice">No quizzes yet. Create the first one and invite your friends.</div>`;
  document.querySelectorAll(".host-quiz").forEach(b=>b.onclick=()=>{const name=prompt("Your nickname?","Host");if(name)socket.emit("room:create",{quizId:Number(b.dataset.id),name})});
  }catch(e){$("#quiz-library").innerHTML='<p class="hint">Could not load quizzes. Refresh and try again.</p>'}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
$("#join-form").onsubmit=e=>{e.preventDefault();socket.emit("room:join",{code:$("#join-code").value.trim().toUpperCase(),name:$("#join-name").value.trim()})};
socket.on("connect",()=>loadQuizzes());
socket.on("room:error",msg=>toast(msg));
socket.on("room:joined",room=>{selfId=room.selfId;currentRoom=room;showPanel(null);$("#room-panel").hidden=false;renderRoom(room);$("#room-panel").scrollIntoView({behavior:"smooth",block:"start"})});
socket.on("room:update",room=>{currentRoom=room;renderRoom(room)});
function renderRoom(room) {
  const root = $("#room-content");
  $("#room-panel").hidden = false;
  const me = room.players.find(p => p.id === selfId);
  const isHost = Boolean(me && me.host);
  const players = room.players.map(p => `<div class="player"><b>${escapeHtml(p.name)}${p.host ? " ★" : ""}</b><small class="status">${p.ready ? "● Ready" : "○ Not ready"}</small></div>`).join("");
  let html = `<div class="panel-head"><div><p class="eyebrow">${room.phase === "waiting" ? "WAITING ROOM" : "LIVE GAME"}</p><h2>${escapeHtml(room.title)}</h2></div><button class="icon-btn" id="leave-room" title="Hide room">✕</button></div>`;
  if (room.phase === "waiting") {
    html += `<p>Share this room code with your friends:</p><div class="room-code">${room.code}</div><button class="btn secondary" id="copy-code">Copy room code</button><h3>Players <span class="count">(${room.players.length}/20)</span></h3><div class="player-list">${players}</div><p class="hint">Everyone must be ready before the host can start.</p>`;
    if (!isHost) html += `<button class="btn primary" id="ready-btn" ${me && me.ready ? "disabled" : ""}>${me && me.ready ? "✓ You're ready" : "I'm ready"}</button>`;
    else html += `<button class="btn primary" id="start-btn" ${room.players.length < 2 || room.players.some(p => !p.ready) ? "disabled" : ""}>Start game ↗</button>`;
  } else if (room.phase === "question") {
    const q = room.question;
    const answered = Boolean(me && me.answered);
    html += `<p class="eyebrow">QUESTION ${room.current + 1} OF ${room.total}</p><h3 class="game-question">${escapeHtml(q.prompt)}</h3>`;
    if (q.image) html += `<img class="question-image" src="${q.image}" alt="Quiz clue">`;
    html += `<div class="choice-grid">${q.choices.map((c, i) => `<button class="choice" data-answer="${i}" ${answered ? "disabled" : ""}>${String.fromCharCode(65 + i)}. ${escapeHtml(c)}</button>`).join("")}</div><p class="hint">${answered ? "Answer submitted. Waiting for the rest of the room…" : "Choose your answer. Correct answers earn 1,000 points."}</p><p class="hint">${room.players.filter(p => p.answered).length} / ${room.players.length} answered</p>`;
  } else {
    html += `<div class="notice">${room.phase === "finished" ? "🏆 Game complete!" : "Round complete — here's the leaderboard."}</div><table class="leaderboard"><thead><tr><th>RANK</th><th>PLAYER</th><th>POINTS</th></tr></thead><tbody>${room.leaderboard.map((p, i) => `<tr><td class="rank">${["🥇", "🥈", "🥉"][i] || i + 1}</td><td>${escapeHtml(p.name)}</td><td>${p.score.toLocaleString()}</td></tr>`).join("")}</tbody></table>`;
    if (isHost && room.phase === "leaderboard") html += `<button class="btn primary" id="next-btn">${room.current + 1 >= room.total ? "Finish game" : "Next question →"}</button>`;
    if (room.phase === "finished") html += `<button class="btn secondary" id="back-home">Back to quizzes</button>`;
  }
  root.innerHTML = html;
  $("#leave-room")?.addEventListener("click", () => { $("#room-panel").hidden = true; });
  $("#copy-code")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(room.code); toast("Room code copied"); } catch { toast("Room code: " + room.code); } });
  $("#ready-btn")?.addEventListener("click", () => socket.emit("player:ready"));
  $("#start-btn")?.addEventListener("click", () => socket.emit("game:start"));
  root.querySelectorAll("[data-answer]").forEach(b => b.onclick = () => { socket.emit("answer:submit", { index: Number(b.dataset.answer) }); root.querySelectorAll("[data-answer]").forEach(x => x.disabled = true); b.style.borderColor = "var(--pink)"; });
  $("#next-btn")?.addEventListener("click", () => socket.emit("game:next"));
  $("#back-home")?.addEventListener("click", () => { $("#room-panel").hidden = true; loadQuizzes(); });
}
loadQuizzes();
