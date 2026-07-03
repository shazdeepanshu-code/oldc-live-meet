/**
 * server.js
 * -----------------------------------------------------------------------
 * Entry point for OLDC LIVE MEET.
 *  - Express serves the static frontend + REST API
 *  - Socket.IO handles real-time classroom presence + WebRTC signaling,
 *    scoped per-lecture (each teacher-created lecture is its own room),
 *    plus the waiting-room push flow and teacher live-moderation controls
 *  - SQLite (via models/db.js) stores teachers, lectures, student
 *    accounts, waiting-room requests, and attendance sessions
 * -----------------------------------------------------------------------
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const { Server } = require('socket.io');

const { SessionModel, LectureModel } = require('./models/db');
const attendanceRoutes = require('./routes/attendance');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const teacherController = require('./controllers/teacherController');
const attendanceController = require('./controllers/attendanceController');

const PORT = process.env.PORT || 3000;

// On boot, close out anything left "online"/"live" from a previous run
// (e.g. after a crash/restart) so stats stay accurate and room codes free up.
SessionModel.clearStaleOnline();
LectureModel.clearStaleLive();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Give controllers a reference to Socket.IO so plain REST endpoints can
// push real-time events (lecture-ended, waiting-room-update, admit/deny...).
teacherController.setIO(io);
attendanceController.setIO(io);

// -------------------------------------------------------------------------
// MIDDLEWARE
// -------------------------------------------------------------------------
app.use(cors());
app.use(express.json());
// sendBeacon sends a Blob with type text/plain;charset=UTF-8 by default,
// so we also parse text bodies and try to JSON.parse them.
app.use(express.text({ type: ['text/plain', 'application/json'] }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.length) {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      /* leave as-is if it isn't JSON */
    }
  }
  next();
});

const SESSION_SECRET = 'oldc-live-meet-secret-key-change-in-production';
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// -------------------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------------------
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/classroom.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'classroom.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/teacher.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.get('/teacher-live.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher-live.html')));

// -------------------------------------------------------------------------
// SOCKET.IO — presence, WebRTC signaling, waiting room, teacher moderation
// Rooms are scoped PER LECTURE: each lecture's unique room_code becomes
// the Socket.IO room name, so multiple lectures can run at once without
// students in different classes seeing each other.
// -------------------------------------------------------------------------
// roomCode -> Map(socketId -> participant info)
const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
  return rooms.get(roomCode);
}

function pushLiveRosterToTeacher(roomCode) {
  const roster = Array.from(getRoom(roomCode).values());
  io.to(`teacher-lecture:${roomCode}`).emit('live-participants-update', roster);
}

function visibleCount(roomCode) {
  return Array.from(getRoom(roomCode).values()).filter((p) => !p.isObserver).length;
}

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  /**
   * Teacher opens their live control panel for a lecture — joins a
   * teacher-only channel to receive waiting-room pushes and the live
   * participant roster (separate from the student video-mesh room).
   */
  socket.on('teacher-watch', ({ roomCode }) => {
    if (!roomCode) return;
    socket.join(`teacher-lecture:${roomCode}`);
    socket.data.teacherRoomCode = roomCode;
    pushLiveRosterToTeacher(roomCode);
  });

  /**
   * Student, right after calling POST /api/attendance/request-join, opens
   * a socket and parks here to receive the teacher's admit/deny decision.
   */
  socket.on('student-wait', ({ roomCode, studentAccountId }) => {
    if (!roomCode || !studentAccountId) return;
    socket.join(`waiting:${roomCode}:${studentAccountId}`);
  });

  /**
   * Student was admitted (their socket already received 'join-approved'
   * with a sessionId) — this links the live socket to that session/room
   * and notifies other peers in the SAME lecture so WebRTC can connect.
   * Also used by the Admin observer (isObserver: true, no sessionId).
   */
  socket.on('join-room', ({ sessionId, studentInfo, roomCode, isObserver, isTeacherBroadcast }) => {
    if (!roomCode) return;

    socket.join(roomCode);
    socket.data.sessionId = sessionId || null;
    socket.data.studentInfo = studentInfo;
    socket.data.roomCode = roomCode;
    socket.data.isObserver = !!isObserver;
    socket.data.isTeacherBroadcast = !!isTeacherBroadcast;

    if (sessionId) SessionModel.attachSocket(sessionId, socket.id);

    const roomParticipants = getRoom(roomCode);
    roomParticipants.set(socket.id, {
      socketId: socket.id,
      sessionId: sessionId || null,
      ...studentInfo,
      isObserver: !!isObserver,
      isTeacherBroadcast: !!isTeacherBroadcast,
      cameraOn: true,
      micOn: true,
      handRaised: false,
    });

    const existing = Array.from(roomParticipants.values()).filter((p) => p.socketId !== socket.id);
    socket.emit('room-participants', existing);

    if (!isObserver) {
      socket.to(roomCode).emit('user-joined', roomParticipants.get(socket.id));
      console.log(`🎓 ${studentInfo?.fullName || 'A student'} joined lecture room ${roomCode}`);
    }

    io.to(roomCode).emit('participant-count', visibleCount(roomCode));
    pushLiveRosterToTeacher(roomCode);
  });

  // --- WebRTC signaling relay (mesh topology) ---------------------------
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice-candidate', { from: socket.id, candidate });
  });

  // --- In-classroom controls ----------------------------------------------
  socket.on('toggle-camera', ({ on }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const p = getRoom(roomCode).get(socket.id);
    if (p) p.cameraOn = on;
    socket.to(roomCode).emit('peer-camera-toggle', { socketId: socket.id, on });
    pushLiveRosterToTeacher(roomCode);
  });

  socket.on('toggle-mic', ({ on }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const p = getRoom(roomCode).get(socket.id);
    if (p) p.micOn = on;
    socket.to(roomCode).emit('peer-mic-toggle', { socketId: socket.id, on });
    pushLiveRosterToTeacher(roomCode);
  });

  socket.on('raise-hand', ({ raised }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const p = getRoom(roomCode).get(socket.id);
    if (p) p.handRaised = raised;
    io.to(roomCode).emit('peer-raise-hand', { socketId: socket.id, raised, name: p?.fullName });
    pushLiveRosterToTeacher(roomCode);
  });

  socket.on('screen-share-toggle', ({ on }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit('peer-screen-share', { socketId: socket.id, on });
  });

  /**
   * Explicit leave (user clicked "Leave Class"). Closes the attendance
   * session with reason "Manual Leave" and removes them from the roster.
   */
  socket.on('leave-room', () => {
    closeParticipant(socket, 'Manual Leave');
  });

  socket.on('disconnect', () => {
    closeParticipant(socket, 'Disconnect');
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });

  function closeParticipant(socket, reason) {
    const sessionId = socket.data.sessionId;
    const roomCode = socket.data.roomCode;

    if (sessionId) {
      SessionModel.closeSession(sessionId, reason);
    }

    if (roomCode && rooms.has(roomCode)) {
      const roomParticipants = rooms.get(roomCode);
      if (roomParticipants.has(socket.id)) {
        roomParticipants.delete(socket.id);
        if (!socket.data.isObserver) {
          socket.to(roomCode).emit('user-left', { socketId: socket.id, reason });
        }
        io.to(roomCode).emit('participant-count', visibleCount(roomCode));
      }
      if (roomParticipants.size === 0) rooms.delete(roomCode);
      pushLiveRosterToTeacher(roomCode);
    }
  }
});

// -------------------------------------------------------------------------
// START SERVER
// -------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('=========================================================');
  console.log(`🚀 OLDC LIVE MEET running on http://localhost:${PORT}`);
  console.log(`   Student portal -> http://localhost:${PORT}/`);
  console.log(`   Teacher portal -> http://localhost:${PORT}/teacher.html  (teacher / teacher123)`);
  console.log(`   Admin portal   -> http://localhost:${PORT}/admin.html    (admin / admin123)`);
  console.log('=========================================================');
});

module.exports = { io };
