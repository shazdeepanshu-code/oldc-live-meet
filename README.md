# 🎥 OLDC LIVE MEET

A secure, role-based online classroom platform — like Google Meet/Zoom, but built for a college: **Teacher, Student, and Admin portals**, teacher-controlled lectures with a **waiting room**, moderation controls, admin **observer mode**, and fully **automatic attendance tracking**. Built with Node.js, Express, Socket.IO, WebRTC, and SQLite.

---

## 🚀 Getting Started

```bash
npm install
npm start
```

Then open:

| Portal    | URL                                  | Default Login            |
|-----------|---------------------------------------|---------------------------|
| 🎓 Student | http://localhost:3000                 | created by a teacher      |
| 👨‍🏫 Teacher | http://localhost:3000/teacher.html   | `teacher` / `teacher123`  |
| 🛠️ Admin   | http://localhost:3000/admin.html      | `admin` / `admin123`      |

> Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module — no native build tools needed).

---

## 🧭 How a class runs

1. **Teacher** logs in, creates lecture accounts for students (username + password — no self sign-up), and creates a **Lecture** (gets a unique room code + shareable join link).
2. Teacher clicks **Start Lecture** — it goes live.
3. **Student** logs in with their assigned credentials, opens the join link (or types the room code), grants camera/mic access, and clicks **Request to Join**.
4. The request lands in the teacher's **Waiting Room** (live control panel). The teacher **Admits** or **Denies** it.
5. On admit, the student enters the video classroom — attendance starts automatically.
6. Teacher can **mute** or **remove** any live participant from the control panel.
7. **Admin** can see all currently live lectures and **watch as a silent observer** (view-only, no camera required).
8. When the teacher clicks **End Lecture**, every connected student is instantly removed and checked out.

---

## 🗂 Structure

```
project/
├── server.js                     # Express + Socket.IO entry point
├── models/db.js                  # SQLite schema + all data access helpers
├── controllers/
│   ├── attendanceController.js   # Student auth + waiting-room request + leave
│   ├── teacherController.js      # Teacher auth, lectures, students, moderation
│   └── adminController.js        # Admin auth, stats, records, live lectures
├── routes/                       # attendance.js, teacher.js, admin.js
├── public/
│   ├── index.html / js/join.js           # Student login + join flow
│   ├── teacher.html / js/teacher.js      # Teacher dashboard
│   ├── teacher-live.html / js/teacher-live.js  # Live waiting room + moderation
│   ├── classroom.html / js/classroom.js  # Video classroom (+ observer mode)
│   └── admin.html / js/admin.js          # Admin dashboard + live lectures
└── database.db                   # SQLite (auto-created on first run)
```

---

## 🔐 Security notes

- Teacher, Student and Admin sessions are completely separate (`req.session.isTeacher` / `isStudent` / `isAdmin`) — one role's session cannot access another portal's protected API routes.
- Students cannot self-register; only a teacher can create student accounts.
- Students cannot enter a live call without an explicit teacher admit.
- Change `SESSION_SECRET` in `server.js` and the default passwords before deploying.

## 🛠 Tech Stack

Node.js + Express · Socket.IO · WebRTC (mesh, STUN) · SQLite (`node:sqlite`) · express-session + bcryptjs · exceljs (Excel export)

---

MIT — free to use and modify.
