const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const db = require('./lib/db');
const { hashPassword, verifyPassword, randomToken, randomCode } = require('./lib/auth');
const { distanceMeters, todayStr, weekdayKo, daysInMonth } = require('./lib/util');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const ROLE_LEVEL = { master: 4, region_rep: 3, admin: 2, instructor: 1, student: 0 };
const CHECKIN_RADIUS_M = 50;
const CHECKIN_CODE_TTL_MS = 60 * 1000;

// ---------- in-memory sessions ----------
const sessions = new Map(); // token -> userId

function isAtLeast(user, role) {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL[role];
}
function canApprove(user) {
  return user && ['master', 'region_rep', 'admin'].includes(user.role);
}
function canEditTimetable(user) {
  return user && ['master', 'region_rep', 'admin'].includes(user.role);
}
function canManagePayments(user) {
  return user && ['master', 'region_rep', 'admin'].includes(user.role);
}
function canWriteInstructorFeedback(user) {
  return user && ['master', 'region_rep', 'admin', 'instructor'].includes(user.role);
}
function canCreateAssignment(user) {
  return user && ['master', 'region_rep', 'admin', 'instructor'].includes(user.role);
}
function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// ---------- body / cookies ----------
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(p => {
    const idx = p.indexOf('=');
    if (idx === -1) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.sid;
  if (!token || !sessions.has(token)) return null;
  const userId = sessions.get(token);
  return db.getById('users', userId);
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback for role pages without extension
      const alt = path.join(PUBLIC_DIR, pathname + '.html');
      if (fs.existsSync(alt)) return streamFile(res, alt);
      res.writeHead(404); return res.end('Not found');
    }
    streamFile(res, filePath);
  });
}
function streamFile(res, filePath) {
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ================= ROUTE HANDLERS =================

async function handleSignup(body) {
  const { role, phone, password, name, level, desiredDays, mbti, disc, career, joinPeriod, regionId, extra } = body;
  if (!['student', 'instructor'].includes(role)) return { status: 400, body: { error: '가입 가능한 역할이 아닙니다.' } };
  if (!phone || !password || !name) return { status: 400, body: { error: '필수 정보가 누락되었습니다.' } };
  if (db.findOne('users', u => u.phone === phone)) return { status: 400, body: { error: '이미 등록된 휴대폰 번호입니다.' } };
  const user = db.insert('users', {
    role, phone, passwordHash: hashPassword(password), name,
    regionId: regionId || null,
    status: 'pending', // pending -> active -> inactive(퇴사/숨김)
    createdAt: new Date().toISOString(),
    profile: { level: level || null, desiredDays: desiredDays || [], mbti: mbti || '', disc: disc || '', career: career || '', joinPeriod: joinPeriod || '', extra: extra || '' }
  });
  return { status: 200, body: { user: safeUser(user) } };
}

async function handleLogin(body, res) {
  const { phone, password } = body;
  const user = db.findOne('users', u => u.phone === phone);
  if (!user || !verifyPassword(password, user.passwordHash)) return { status: 401, body: { error: '휴대폰번호 또는 비밀번호가 올바르지 않습니다.' } };
  if (user.status === 'pending') return { status: 403, body: { error: '아직 승인 대기 중입니다. 관리자 승인 후 로그인할 수 있습니다.' } };
  if (user.status === 'inactive') return { status: 403, body: { error: '비활성화된 계정입니다.' } };
  const token = randomToken();
  sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`);
  return { status: 200, body: { user: safeUser(user) } };
}

// ================= SERVER =================

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (pathname.startsWith('/uploads/')) {
    const filePath = path.join(UPLOAD_DIR, pathname.replace('/uploads/', ''));
    if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
    return streamFile(res, filePath);
  }
  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 413, { error: 'payload too large' }); }
  }

  const user = getCurrentUser(req);

  try {
    // ---------- AUTH ----------
    if (pathname === '/api/signup' && req.method === 'POST') {
      const r = await handleSignup(body); return sendJSON(res, r.status, r.body);
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const r = await handleLogin(body, res); return sendJSON(res, r.status, r.body);
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.sid) sessions.delete(cookies.sid);
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJSON(res, 200, { user: safeUser(user) });
    }

    // everything below requires login
    if (!user) return sendJSON(res, 401, { error: '로그인이 필요합니다.' });

    // ---------- APPROVALS / USER MGMT ----------
    if (pathname === '/api/pending-users' && req.method === 'GET') {
      if (!canApprove(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      return sendJSON(res, 200, { users: db.find('users', u => u.status === 'pending').map(safeUser) });
    }
    if (pathname.match(/^\/api\/users\/\d+\/approve$/) && req.method === 'POST') {
      if (!canApprove(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const updated = db.update('users', id, { status: 'active', approvedBy: user.id, approvedAt: new Date().toISOString() });
      return sendJSON(res, 200, { user: safeUser(updated) });
    }
    if (pathname.match(/^\/api\/users\/\d+\/reset-password$/) && req.method === 'POST') {
      if (!canApprove(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const temp = randomCode(8);
      db.update('users', id, { passwordHash: hashPassword(temp), mustChangePassword: true });
      return sendJSON(res, 200, { tempPassword: temp });
    }
    if (pathname === '/api/change-phone' && req.method === 'POST') {
      const { newPhone } = body;
      if (!newPhone || !newPhone.trim()) return sendJSON(res, 400, { error: '아이디(휴대폰번호)를 입력하세요.' });
      const clean = newPhone.trim();
      if (clean !== user.phone && db.findOne('users', u => u.phone === clean)) return sendJSON(res, 400, { error: '이미 사용 중인 아이디입니다.' });
      db.update('users', user.id, { phone: clean });
      return sendJSON(res, 200, { ok: true, phone: clean });
    }
    if (pathname === '/api/change-password' && req.method === 'POST') {
      const { newPassword } = body;
      if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: '비밀번호는 4자 이상이어야 합니다.' });
      db.update('users', user.id, { passwordHash: hashPassword(newPassword), mustChangePassword: false });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname.match(/^\/api\/users\/\d+\/status$/) && req.method === 'POST') {
      if (!canApprove(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const { status } = body; // active | inactive
      const updated = db.update('users', id, { status });
      return sendJSON(res, 200, { user: safeUser(updated) });
    }
    if (pathname === '/api/students' && req.method === 'GET') {
      const status = query.status || 'active';
      let students = db.find('users', u => u.role === 'student' && u.status === status);
      if (query.regionId) students = students.filter(s => String(s.regionId) === String(query.regionId));
      if (query.level) students = students.filter(s => s.profile && s.profile.level === query.level);
      return sendJSON(res, 200, { students: students.map(safeUser) });
    }
    if (pathname === '/api/staff' && req.method === 'GET') {
      // instructors + admins list (for assigning leader/instructor)
      const staff = db.find('users', u => ['instructor', 'admin', 'region_rep', 'master'].includes(u.role) && u.status === 'active');
      return sendJSON(res, 200, { staff: staff.map(safeUser) });
    }

    // ---------- REGIONS ----------
    if (pathname === '/api/regions' && req.method === 'GET') {
      return sendJSON(res, 200, { regions: db.all('regions') });
    }
    if (pathname === '/api/regions' && req.method === 'POST') {
      if (user.role !== 'master') return sendJSON(res, 403, { error: '마스터만 지역을 추가할 수 있습니다.' });
      const { name, lat, lng, address } = body;
      const region = db.insert('regions', { name, lat, lng, address });
      return sendJSON(res, 200, { region });
    }

    // ---------- TIMETABLE TEMPLATE ----------
    if (pathname === '/api/timetable/template' && req.method === 'GET') {
      let rows = db.all('timetable_templates');
      if (query.regionId) rows = rows.filter(r => String(r.regionId) === String(query.regionId));
      return sendJSON(res, 200, { templates: rows });
    }
    if (pathname === '/api/timetable/template' && req.method === 'POST') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { level, weekday, startTime, endTime, room, regionId, isInternal, title } = body;
      const row = db.insert('timetable_templates', { level, weekday, startTime, endTime, room, regionId, isInternal: !!isInternal, title: title || '' });
      return sendJSON(res, 200, { template: row });
    }
    if (pathname.match(/^\/api\/timetable\/template\/\d+$/) && req.method === 'DELETE') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[4];
      db.remove('timetable_templates', id);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- TIMETABLE MONTH (generated) ----------
    if (pathname === '/api/timetable/month' && req.method === 'GET') {
      const year = Number(query.year), month = Number(query.month);
      const regionId = query.regionId;
      const showInternal = query.showInternal === 'true';
      let templates = db.all('timetable_templates');
      if (regionId) templates = templates.filter(t => String(t.regionId) === String(regionId));
      if (!showInternal) templates = templates.filter(t => !t.isInternal);
      const nDays = daysInMonth(year, month);
      const overrides = db.find('timetable_instances', i => i.year === year && i.month === month);
      const days = [];
      for (let d = 1; d <= nDays; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const wd = weekdayKo(dateStr);
        const dayTemplates = templates.filter(t => t.weekday === wd);
        const items = dayTemplates.map(t => {
          const ov = overrides.find(o => o.templateId === t.id && o.date === dateStr);
          if (ov && ov.cancelled) return null;
          return Object.assign({}, t, ov ? ov.patch : {}, { date: dateStr, templateId: t.id, instanceKey: `${t.id}_${dateStr}` });
        }).filter(Boolean);
        days.push({ date: dateStr, weekday: wd, items });
      }
      return sendJSON(res, 200, { days });
    }
    if (pathname === '/api/timetable/override' && req.method === 'POST') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { templateId, date, patch, cancelled } = body;
      const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
      const existing = db.findOne('timetable_instances', i => i.templateId === templateId && i.date === date);
      if (existing) { db.update('timetable_instances', existing.id, { patch: patch || {}, cancelled: !!cancelled }); }
      else { db.insert('timetable_instances', { templateId, date, year, month, patch: patch || {}, cancelled: !!cancelled }); }
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- ATTENDANCE ----------
    if (pathname === '/api/attendance' && req.method === 'GET') {
      const instanceKey = query.instanceKey;
      const rows = db.find('attendance', a => a.instanceKey === instanceKey);
      return sendJSON(res, 200, { attendance: rows });
    }
    if (pathname === '/api/attendance/check' && req.method === 'POST') {
      if (!['master', 'region_rep', 'admin', 'instructor'].includes(user.role)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { instanceKey, period, studentId, status } = body;
      const VALID = ['출석', '보강', '지각', '조퇴', '병결', '행사', '결석'];
      if (!VALID.includes(status)) return sendJSON(res, 400, { error: '유효하지 않은 출석 상태입니다.' });
      const existing = db.findOne('attendance', a => a.instanceKey === instanceKey && a.period === period && a.studentId === studentId);
      let row;
      if (existing) row = db.update('attendance', existing.id, { status, checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'manual' });
      else row = db.insert('attendance', { instanceKey, period, studentId, status, checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'manual' });
      return sendJSON(res, 200, { attendance: row });
    }
    // rotating check-in code (QR substitute; encode as a QR image client-side pointing to a URL with this code)
    if (pathname === '/api/attendance/checkin-code/generate' && req.method === 'POST') {
      if (!['master', 'region_rep', 'admin', 'instructor'].includes(user.role)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { instanceKey, period, regionId } = body;
      const code = randomCode(6);
      const row = db.insert('checkin_codes', {
        instanceKey, period, regionId, code,
        expiresAt: Date.now() + CHECKIN_CODE_TTL_MS, createdBy: user.id
      });
      return sendJSON(res, 200, { code: row.code, expiresAt: row.expiresAt, ttlMs: CHECKIN_CODE_TTL_MS });
    }
    if (pathname === '/api/attendance/checkin-code/submit' && req.method === 'POST') {
      if (user.role !== 'student') return sendJSON(res, 403, { error: '수강생만 사용할 수 있습니다.' });
      const { code, lat, lng } = body;
      const session = [...db.all('checkin_codes')].reverse().find(c => c.code === code);
      if (!session) return sendJSON(res, 400, { error: '유효하지 않은 코드입니다.' });
      if (Date.now() > session.expiresAt) return sendJSON(res, 400, { error: '코드가 만료되었습니다. (1분 유효)' });
      if (lat === undefined || lng === undefined) return sendJSON(res, 400, { error: '위치 정보가 필요합니다.' });
      const region = db.getById('regions', session.regionId);
      if (!region || region.lat === undefined || region.lng === undefined) return sendJSON(res, 400, { error: '지점 위치 정보가 설정되지 않았습니다.' });
      const dist = distanceMeters(lat, lng, region.lat, region.lng);
      if (dist > CHECKIN_RADIUS_M) return sendJSON(res, 400, { error: `학원 위치에서 너무 멉니다 (약 ${Math.round(dist)}m). 강사에게 수동 체크를 요청하세요.` });
      const existing = db.findOne('attendance', a => a.instanceKey === session.instanceKey && a.period === session.period && a.studentId === user.id);
      let row;
      const payload = { status: '출석', checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'checkin_code' };
      if (existing) row = db.update('attendance', existing.id, payload);
      else row = db.insert('attendance', Object.assign({ instanceKey: session.instanceKey, period: session.period, studentId: user.id }, payload));
      return sendJSON(res, 200, { attendance: row });
    }
    if (pathname === '/api/attendance/stats' && req.method === 'GET') {
      const STATUSES = ['출석', '보강', '지각', '조퇴', '병결', '행사', '결석'];
      let students = db.find('users', u => u.role === 'student' && u.status === 'active');
      if (query.regionId) students = students.filter(s => String(s.regionId) === String(query.regionId));
      if (query.level) students = students.filter(s => s.profile && s.profile.level === query.level);
      if (query.studentId) students = students.filter(s => String(s.id) === String(query.studentId));
      const allAttendance = db.all('attendance');
      const stats = students.map(s => {
        const rows = allAttendance.filter(a => a.studentId === s.id);
        const total = rows.length;
        const counts = {}; STATUSES.forEach(st => counts[st] = 0);
        rows.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
        const percents = {};
        STATUSES.forEach(st => percents[st] = total ? Math.round((counts[st] / total) * 1000) / 10 : 0);
        return { student: safeUser(s), total, counts, percents };
      });
      return sendJSON(res, 200, { stats });
    }

    // ---------- FEEDBACK: instructor/leader -> student ----------
    if (pathname === '/api/feedback/instructor' && req.method === 'POST') {
      if (!canWriteInstructorFeedback(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { studentId, instanceKey, comment } = body;
      if (!comment) return sendJSON(res, 400, { error: '내용을 입력하세요.' });
      const row = db.insert('feedback_instructor', { studentId, instanceKey, comment, authorId: user.id, createdAt: new Date().toISOString() });
      return sendJSON(res, 200, { feedback: row });
    }
    if (pathname === '/api/feedback/instructor' && req.method === 'GET') {
      let rows = db.all('feedback_instructor');
      if (query.studentId) rows = rows.filter(r => String(r.studentId) === String(query.studentId));
      // students may only see their own
      if (user.role === 'student' && String(user.id) !== String(query.studentId)) rows = [];
      const withAuthor = rows.map(r => Object.assign({}, r, { authorName: (db.getById('users', r.authorId) || {}).name }));
      return sendJSON(res, 200, { feedback: withAuthor });
    }

    // ---------- FEEDBACK: student -> instructor ----------
    if (pathname === '/api/feedback/student' && req.method === 'POST') {
      if (user.role !== 'student') return sendJSON(res, 403, { error: '수강생만 작성할 수 있습니다.' });
      const { instanceKey, instructorId, difficulty, moods, comment } = body;
      const row = db.insert('feedback_student', {
        instanceKey, instructorId, difficulty: difficulty || null, moods: moods || [],
        comment: comment || '', studentId: user.id, createdAt: new Date().toISOString()
      });
      return sendJSON(res, 200, { feedback: row });
    }
    if (pathname === '/api/feedback/student' && req.method === 'GET') {
      let rows = db.all('feedback_student');
      if (query.instructorId) rows = rows.filter(r => String(r.instructorId) === String(query.instructorId));
      // instructors see anonymized (no studentId/name); admins+ see author identity
      const revealAuthor = isAtLeast(user, 'admin');
      const out = rows.map(r => {
        const base = { id: r.id, instanceKey: r.instanceKey, instructorId: r.instructorId, difficulty: r.difficulty, moods: r.moods, comment: r.comment, createdAt: r.createdAt };
        if (revealAuthor) base.studentName = (db.getById('users', r.studentId) || {}).name;
        if (String(r.studentId) === String(user.id)) base.mine = true;
        return base;
      });
      return sendJSON(res, 200, { feedback: out });
    }

    // ---------- ASSIGNMENTS (과제/선물) ----------
    if (pathname === '/api/assignments' && req.method === 'POST') {
      if (!canCreateAssignment(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { title, description, level, weekday, deadline, submissionType, regionId } = body;
      if (!title || !deadline) return sendJSON(res, 400, { error: '제목과 마감일은 필수입니다.' });
      const row = db.insert('assignments', {
        title, description: description || '', level: level || null, weekday: weekday || null,
        deadline, submissionType: submissionType || 'none', regionId: regionId || null,
        createdBy: user.id, createdAt: new Date().toISOString()
      });
      return sendJSON(res, 200, { assignment: row });
    }
    if (pathname === '/api/assignments' && req.method === 'GET') {
      let rows = db.all('assignments');
      if (query.level) rows = rows.filter(a => !a.level || a.level === query.level);
      if (query.weekday) rows = rows.filter(a => !a.weekday || a.weekday === query.weekday);
      if (query.regionId) rows = rows.filter(a => !a.regionId || String(a.regionId) === String(query.regionId));
      const subs = db.all('assignment_submissions');
      rows = rows.map(a => Object.assign({}, a, {
        mySubmission: user.role === 'student' ? (subs.find(s => s.assignmentId === a.id && s.studentId === user.id) || null) : undefined,
        submissionCount: subs.filter(s => s.assignmentId === a.id).length
      }));
      return sendJSON(res, 200, { assignments: rows });
    }
    if (pathname.match(/^\/api\/assignments\/\d+\/submissions$/) && req.method === 'GET') {
      const id = Number(pathname.split('/')[3]);
      if (!canCreateAssignment(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const subs = db.find('assignment_submissions', s => s.assignmentId === id).map(s => Object.assign({}, s, { studentName: (db.getById('users', s.studentId) || {}).name }));
      return sendJSON(res, 200, { submissions: subs });
    }
    if (pathname === '/api/assignments/submit' && req.method === 'POST') {
      if (user.role !== 'student') return sendJSON(res, 403, { error: '수강생만 제출할 수 있습니다.' });
      const { assignmentId, type, content, comment, fileName, fileData } = body; // type: file|link|none
      const assignment = db.getById('assignments', assignmentId);
      if (!assignment) return sendJSON(res, 404, { error: '과제를 찾을 수 없습니다.' });
      let storedPath = null;
      if (type === 'file' && fileData) {
        const buf = Buffer.from(fileData, 'base64');
        const safeName = `${Date.now()}_${user.id}_${(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
        storedPath = `/uploads/${safeName}`;
      }
      const existing = db.findOne('assignment_submissions', s => s.assignmentId === assignmentId && s.studentId === user.id);
      const payload = {
        type, content: type === 'link' ? content : storedPath, comment: comment || '',
        completedAt: new Date().toISOString()
      };
      let row;
      if (existing) row = db.update('assignment_submissions', existing.id, payload);
      else row = db.insert('assignment_submissions', Object.assign({ assignmentId, studentId: user.id }, payload));
      return sendJSON(res, 200, { submission: row });
    }
    if (pathname === '/api/notifications/assignments' && req.method === 'GET') {
      // D-1 / D-2 reminders relevant to current user
      const rows = db.all('assignments');
      const today = new Date(todayStr());
      const relevant = rows.filter(a => {
        if (user.role === 'student' && a.level && user.profile && a.level !== user.profile.level) return false;
        const dl = new Date(a.deadline);
        const diffDays = Math.round((dl - today) / (1000 * 60 * 60 * 24));
        return diffDays === 1 || diffDays === 2 || diffDays === 0;
      }).map(a => {
        const dl = new Date(a.deadline);
        const diffDays = Math.round((dl - today) / (1000 * 60 * 60 * 24));
        return Object.assign({}, a, { dDay: diffDays });
      });
      return sendJSON(res, 200, { notifications: relevant });
    }

    // ---------- PAYMENTS ----------
    if (pathname === '/api/payments' && req.method === 'POST') {
      if (!canManagePayments(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { studentId, depositorName, amount, installments, isDeferred } = body;
      if (!studentId || !depositorName || !amount) return sendJSON(res, 400, { error: '수강생, 입금자명, 금액은 필수입니다.' });
      const insts = (installments && installments.length ? installments : [{ no: 1, amount, dueDate: null, paid: false }])
        .map((it, idx) => ({ no: it.no || idx + 1, amount: it.amount, dueDate: it.dueDate || null, paid: !!it.paid }));
      const row = db.insert('payments', {
        studentId, depositorName, amount, isDeferred: !!isDeferred,
        installments: insts, createdBy: user.id, createdAt: new Date().toISOString()
      });
      return sendJSON(res, 200, { payment: row });
    }
    if (pathname === '/api/payments' && req.method === 'GET') {
      let rows = db.all('payments');
      if (query.studentId) rows = rows.filter(p => String(p.studentId) === String(query.studentId));
      if (user.role === 'student') rows = rows.filter(p => String(p.studentId) === String(user.id));
      const refunds = db.all('refunds');
      rows = rows.map(p => Object.assign({}, p, {
        studentName: (db.getById('users', p.studentId) || {}).name,
        refunds: refunds.filter(r => r.studentId === p.studentId)
      }));
      return sendJSON(res, 200, { payments: rows });
    }
    if (pathname.match(/^\/api\/payments\/\d+\/installment\/\d+\/toggle$/) && req.method === 'POST') {
      if (!canManagePayments(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const parts = pathname.split('/');
      const paymentId = Number(parts[3]), no = Number(parts[5]);
      const payment = db.getById('payments', paymentId);
      if (!payment) return sendJSON(res, 404, { error: 'not found' });
      const inst = payment.installments.find(i => i.no === no);
      if (!inst) return sendJSON(res, 404, { error: 'installment not found' });
      inst.paid = !inst.paid;
      db.update('payments', paymentId, { installments: payment.installments });
      return sendJSON(res, 200, { payment });
    }
    if (pathname === '/api/refunds' && req.method === 'POST') {
      if (!canManagePayments(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { studentId, amount, reason } = body;
      const row = db.insert('refunds', { studentId, amount, reason, processedBy: user.id, processedAt: new Date().toISOString() });
      return sendJSON(res, 200, { refund: row });
    }

    return sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: 'server error', detail: String(err.message || err) });
  }
});

// uploads static
const origServeStatic = serveStatic;
server.on('request', () => {}); // no-op, kept for clarity

server.listen(PORT, () => {
  console.log(`Academy app running at http://localhost:${PORT}`);
});
