require("dotenv").config();
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir, { fallthrough: false }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const db = new Database(path.join(__dirname, "quiz.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS quizzes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS questions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
 prompt TEXT NOT NULL,
 image_path TEXT,
 choices_json TEXT NOT NULL,
 answer_index INTEGER NOT NULL,
 points INTEGER NOT NULL DEFAULT 1000
);
`);
const insertQuiz = db.prepare("INSERT INTO quizzes(title) VALUES (?)");
const insertQuestion = db.prepare("INSERT INTO questions(quiz_id,prompt,image_path,choices_json,answer_index,points) VALUES (?,?,?,?,?,?)");
const roomStore = new Map();
const cleanText = (v, max=160) => String(v ?? "").trim().replace(/[<>]/g, "").slice(0, max);
const roomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
};
const publicRoom = room => ({
  code: room.code, title: room.title, phase: room.phase, current: room.current,
  total: room.questions.length,
  players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, ready:p.ready, score:p.score, host:p.host,
    answered: room.phase === "question" && p.answers[room.current] !== undefined })),
  question: room.phase === "question" && room.questions[room.current] ? {
    prompt: room.questions[room.current].prompt,
    image: room.questions[room.current].image_path,
    choices: room.questions[room.current].choices
  } : null,
  leaderboard: [...room.players.values()].map(p => ({ name:p.name, score:p.score }))
    .sort((a,b)=>b.score-a.score)
});
function broadcast(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function safeRoom(code) { return roomStore.get(String(code || "").toUpperCase()); }

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: Math.min(Number(process.env.MAX_UPLOAD_MB || 5), 10) * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Upload a JPG, PNG, WEBP or GIF image."), allowed.includes(file.mimetype));
  }
});

app.get("/api/quizzes", (_, res) => {
  const quizzes = db.prepare("SELECT id,title,created_at FROM quizzes ORDER BY id DESC LIMIT 30").all();
  res.json(quizzes);
});
app.get("/api/quizzes/:id", (req, res) => {
  const quiz = db.prepare("SELECT id,title FROM quizzes WHERE id=?").get(Number(req.params.id));
  if (!quiz) return res.status(404).json({error:"Quiz not found"});
  quiz.questions = db.prepare("SELECT id,prompt,image_path,choices_json,answer_index,points FROM questions WHERE quiz_id=? ORDER BY id").all(quiz.id)
    .map(q=>({id:q.id,prompt:q.prompt,image_path:q.image_path,choices:JSON.parse(q.choices_json),answer_index:q.answer_index,points:q.points}));
  res.json(quiz);
});
app.post("/api/quizzes", upload.array("images", 20), (req, res) => {
  try {
    const title = cleanText(req.body.title, 80);
    const raw = JSON.parse(req.body.questions || "[]");
    if (title.length < 2 || !Array.isArray(raw) || raw.length < 1 || raw.length > 30)
      return res.status(400).json({error:"Add a title and between 1 and 30 questions."});
    const quizId = db.transaction(() => {
      const id = insertQuiz.run(title).lastInsertRowid;
      raw.forEach((q, i) => {
        const prompt = cleanText(q.prompt, 240);
        const choices = Array.isArray(q.choices) ? q.choices.map(x=>cleanText(x,100)) : [];
        const answer = Number(q.answer_index);
        if (!prompt || choices.length !== 4 || choices.some(x=>!x) || !Number.isInteger(answer) || answer < 0 || answer > 3)
          throw new Error(`Question ${i+1}: add a question, four choices and a correct answer.`);
        const file = Number.isInteger(q.image_upload_index) ? req.files?.[q.image_upload_index] : null;
        insertQuestion.run(id,prompt,file ? `/uploads/${file.filename}` : null,JSON.stringify(choices),answer,1000);
      });
      return id;
    })();
    res.status(201).json({id:quizId,title});
  } catch (e) {
    res.status(400).json({error:e.message || "Could not save quiz."});
  }
});

io.on("connection", socket => {
  socket.on("room:create", ({quizId,name}={}) => {
    const quiz = db.prepare("SELECT id,title FROM quizzes WHERE id=?").get(Number(quizId));
    const questions = quiz && db.prepare("SELECT prompt,image_path,choices_json,answer_index,points FROM questions WHERE quiz_id=? ORDER BY id").all(quiz.id)
      .map(q=>({prompt:q.prompt,image_path:q.image_path,choices:JSON.parse(q.choices_json),answer_index:q.answer_index,points:q.points}));
    if (!quiz || !questions?.length) return socket.emit("room:error","Choose a quiz with questions first.");
    let code; do { code = roomCode(); } while(roomStore.has(code));
    const player = {id:socket.id,name:cleanText(name,24)||"Host",ready:true,score:0,host:true,answers:{}};
    const room = {code,title:quiz.title,questions,phase:"waiting",current:0,players:new Map([[socket.id,player]]),timer:null};
    roomStore.set(code,room); socket.join(code); socket.data.roomCode=code;
    socket.emit("room:joined",{...publicRoom(room),selfId:socket.id}); broadcast(room);
  });
  socket.on("room:join", ({code,name}={}) => {
    const room = safeRoom(code);
    if (!room || room.phase !== "waiting") return socket.emit("room:error","Room not found or game already started.");
    if (room.players.size >= 20) return socket.emit("room:error","This room is full (20 players max).");
    const player = {id:socket.id,name:cleanText(name,24)||"Player",ready:false,score:0,host:false,answers:{}};
    room.players.set(socket.id,player); socket.join(room.code); socket.data.roomCode=room.code;
    socket.emit("room:joined",{...publicRoom(room),selfId:socket.id}); broadcast(room);
  });
  socket.on("player:ready", () => {
    const room=safeRoom(socket.data.roomCode), player=room?.players.get(socket.id);
    if (!room || room.phase!=="waiting" || !player || player.host) return;
    player.ready=true; broadcast(room);
  });
  socket.on("game:start", () => {
    const room=safeRoom(socket.data.roomCode), player=room?.players.get(socket.id);
    if (!room || !player?.host || room.phase!=="waiting") return;
    if (room.players.size < 2) return socket.emit("room:error","Invite at least one other player before starting.");
    if ([...room.players.values()].some(p=>!p.ready)) return socket.emit("room:error","Everyone must be ready first.");
    room.phase="question"; room.current=0; broadcast(room);
  });
  socket.on("answer:submit", ({index}={}) => {
    const room=safeRoom(socket.data.roomCode), player=room?.players.get(socket.id);
    if (!room || room.phase!=="question" || !player || player.answers[room.current] !== undefined) return;
    const q=room.questions[room.current], chosen=Number(index);
    if (!Number.isInteger(chosen)||chosen<0||chosen>3) return;
    player.answers[room.current]=chosen;
    if (chosen===q.answer_index) player.score += q.points;
    const answered=[...room.players.values()].every(p=>p.answers[room.current]!==undefined);
    if (answered) room.phase="leaderboard";
    broadcast(room);
  });
  socket.on("game:next", () => {
    const room=safeRoom(socket.data.roomCode), player=room?.players.get(socket.id);
    if (!room || !player?.host || room.phase!=="leaderboard") return;
    if (room.current+1>=room.questions.length) room.phase="finished";
    else { room.current++; room.phase="question"; }
    broadcast(room);
  });
  socket.on("disconnect", () => {
    const room=safeRoom(socket.data.roomCode);
    if (!room) return;
    room.players.delete(socket.id);
    if (!room.players.size) { clearTimeout(room.timer); roomStore.delete(room.code); }
    else {
      if (![...room.players.values()].some(p=>p.host)) room.players.values().next().value.host=true;
      broadcast(room);
    }
  });
});
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({error:err.message});
  if (err) return res.status(400).json({error:err.message || "Request failed."});
  next();
});
server.listen(PORT, "0.0.0.0", () => console.log(`Cinema Quiz running on http://localhost:${PORT}`));
