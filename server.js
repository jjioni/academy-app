const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const db = require('./lib/db');
const { hashPassword, verifyPassword, randomToken, randomCode } = require('./lib/auth');
const { distanceMeters, todayStr, weekdayKo, daysInMonth, lastSaturdayOfMonth, masterCircuitSchedule, yearQuarterLabel } = require('./lib/util');
const google = require('./lib/google');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 4단계 권한 구조: 마스터 / 관리자(매장 리더) / 강사 / 수강생
const ROLE_LEVEL = { master: 3, admin: 2, instructor: 1, student: 0 };
const CHECKIN_RADIUS_M = 50;
// 코드 발급 후 이 시간 안에 제출하면 "출석", 넘으면 "지각". 코드 자체는 만료되지 않고
// 다음 교시 코드가 발급될 때까지 계속 유효하다 (강사마다 진행 속도가 달라 고정 시각 체크가 불가능하기 때문).
const LATE_THRESHOLD_MS = 60 * 1000;
// 결제(회비) 자동 생성 대상 레벨
const BILLABLE_LEVELS = ['1레벨', '2레벨', '3레벨', '4레벨', '강사코스-이나모리', '강사코스-머스크', '세미나'];

// ---------- sessions (persisted to disk so "로그인 유지" survives server restarts —
// an in-memory Map would forget everyone every time the process restarts, which
// happens often on Render's free tier after idle spin-down) ----------
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, matches the cookie Max-Age

function createSession(userId) {
  const token = randomToken();
  db.insert('sessions', { token, userId, createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function destroySession(token) {
  const row = db.findOne('sessions', s => s.token === token);
  if (row) db.remove('sessions', row.id);
}
function touchSession(row) {
  // sliding expiry: every lookup pushes the session another 14 days out, so an
  // actively-used login never gets logged out from under someone
  db.update('sessions', row.id, { expiresAt: Date.now() + SESSION_TTL_MS });
}

function isAtLeast(user, role) {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL[role];
}
function canApprove(user) {
  return user && ['master', 'admin'].includes(user.role);
}
function canEditTimetable(user) {
  return user && ['master', 'admin'].includes(user.role);
}
function canManagePayments(user) {
  return user && ['master', 'admin'].includes(user.role);
}
function canWriteInstructorFeedback(user) {
  return user && ['master', 'admin', 'instructor'].includes(user.role);
}
function canCreateAssignment(user) {
  return user && ['master', 'admin', 'instructor'].includes(user.role);
}

// Legacy helper for old CSV imports / free-text level values (기존 출석부 데이터 호환용).
// 신규 회원가입은 levels 배열을 그대로 받으므로 이 함수를 거치지 않는다.
function expandLevelSelection(raw) {
  const v = (raw || '').trim();
  if (v === '1,2' || v.includes('비기너') || v.includes('러너')) return ['1레벨', '2레벨'];
  if (v === '3,4' || v.includes('챌린저') || v.includes('위너') || v.includes('워너')) return ['3레벨', '4레벨'];
  if (v.includes('이나모리')) return ['강사코스-이나모리'];
  if (v.includes('머스크')) return ['강사코스-머스크'];
  if (v.includes('세미나')) return ['세미나'];
  if (v.includes('강사코스')) return ['강사코스'];
  return v ? [v] : [];
}

// Notify the region's admin(s) ("매장 리더") that a new signup needs approval.
// 리더(관리자) 본인의 가입 신청은 그 매장에 아직 리더가 없다는 뜻이므로 마스터에게 보낸다.
function notifyRegionAdminsOfSignup(newUser) {
  const roleLabel = { student: '수강생', instructor: '강사', admin: '리더' }[newUser.role] || newUser.role;
  if (newUser.role === 'admin') {
    db.find('users', u => u.role === 'master' && u.status === 'active').forEach(master => {
      db.insert('notifications', {
        targetUserId: master.id, type: 'approval_pending',
        message: `${newUser.name}님이 매장 리더(관리자)로 가입 신청했습니다. 승인해주세요.`,
        relatedUserId: newUser.id, read: false, createdAt: new Date().toISOString()
      });
    });
    return;
  }
  if (!newUser.regionId) return;
  const admins = db.find('users', u => u.role === 'admin' && u.status === 'active' && String(u.regionId) === String(newUser.regionId));
  const targets = admins.length ? admins : db.find('users', u => u.role === 'master' && u.status === 'active');
  targets.forEach(admin => {
    db.insert('notifications', {
      targetUserId: admin.id,
      type: 'approval_pending',
      message: `${newUser.name}님이 ${roleLabel}(으)로 가입 신청했습니다. 승인해주세요.`,
      relatedUserId: newUser.id,
      read: false,
      createdAt: new Date().toISOString()
    });
  });
}

// 지각/결석이 확정된 학생의 매장 리더+같은 매장 강사에게 1회 알림 (인앱, 비용 없음)
function notifyAttendanceIssue(attRow, status) {
  if (attRow.notified) return;
  const student = db.getById('users', attRow.studentId);
  if (!student) return;
  const [templateId, date] = String(attRow.instanceKey).split('_');
  const template = db.getById('timetable_templates', templateId);
  const instructor = template && template.instructorId ? db.getById('users', template.instructorId) : null;
  const targets = db.find('users', u => u.status === 'active' && ['admin', 'instructor'].includes(u.role) && String(u.regionId) === String(student.regionId));
  const msg = `[${status}] ${date} ${attRow.period}교시 ${template ? (template.subject || template.title) : ''} (강사: ${instructor ? instructor.name : '-'}) - ${student.name}님 ${status} 확인`;
  targets.forEach(t => {
    db.insert('notifications', {
      targetUserId: t.id, type: 'attendance_alert', message: msg, relatedUserId: student.id,
      read: false, createdAt: new Date().toISOString()
    });
  });
  db.update('attendance', attRow.id, { notified: true });
}

// template의 레벨/매장에 해당하는 재원생 목록
function getEnrolledStudents(template) {
  if (!template || !template.level) return [];
  let list = db.find('users', u => u.role === 'student' && u.status === 'active');
  if (template.regionId) list = list.filter(s => String(s.regionId) === String(template.regionId));
  list = list.filter(s => s.profile && ((s.profile.levels || []).includes(template.level) || s.profile.level === template.level));
  return list;
}

// 이전 교시 코드를 마감하고, 아직 출결 기록이 없는 재원생을 자동 결석 처리한다.
function finalizeCheckinCode(codeRow) {
  db.update('checkin_codes', codeRow.id, { active: false });
  const [templateId] = String(codeRow.instanceKey).split('_');
  const template = db.getById('timetable_templates', templateId);
  const enrolled = getEnrolledStudents(template);
  enrolled.forEach(student => {
    const already = db.findOne('attendance', a => a.instanceKey === codeRow.instanceKey && a.period === codeRow.period && a.studentId === student.id);
    if (already) return;
    const row = db.insert('attendance', {
      instanceKey: codeRow.instanceKey, period: codeRow.period, studentId: student.id,
      status: '결석', checkedBy: null, checkedAt: new Date().toISOString(), method: 'auto'
    });
    notifyAttendanceIssue(row, '결석');
  });
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
  if (!token) return null;
  const row = db.findOne('sessions', s => s.token === token);
  if (!row) return null;
  if (row.expiresAt < Date.now()) { db.remove('sessions', row.id); return null; }
  touchSession(row);
  return db.getById('users', row.userId);
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

// uploads a signup document (ID card / bankbook photo) to Drive, named "{이름}_{문서종류}_{yyyymmdd}.{ext}".
// Returns a Drive view link, or null if not attached / Google isn't configured / upload fails
// (document upload is best-effort — it must never block account creation).
async function uploadSignupDoc(name, docLabel, file) {
  if (!file || !file.data) return null;
  try {
    const ext = (file.fileName && file.fileName.includes('.')) ? file.fileName.split('.').pop() : 'jpg';
    const fileName = `${name}_${docLabel}_${todayStr().replace(/-/g, '')}.${ext}`;
    const result = await google.uploadToDrive(fileName, file.mimeType || 'image/jpeg', file.data);
    return result ? result.webViewLink : null;
  } catch (e) {
    console.error(`Drive upload failed (${docLabel}):`, e.message);
    return null;
  }
}

async function handleSignup(body) {
  const {
    role, phone, password, name, depositorName, levels: rawLevels, level, desiredDays,
    nationality, mbti, disc, career, firstWorkDate, debutMonth, regionId, extra,
    tuitionDateConfirmed, idCardPhoto, bankbookPhoto, storeAddress, securityQuestion, securityAnswer
  } = body;
  if (!['student', 'instructor', 'admin'].includes(role)) return { status: 400, body: { error: '가입 가능한 역할이 아닙니다.' } };
  if (!phone || !password || !name) return { status: 400, body: { error: '필수 정보가 누락되었습니다.' } };
  if (db.findOne('users', u => u.phone === phone)) return { status: 400, body: { error: '이미 등록된 휴대폰 번호입니다.' } };
  // 신규 가입 폼은 레벨을 복수선택 배열로 보낸다. 옛 폼(단일 문자열)이 오면 호환 처리.
  const levels = Array.isArray(rawLevels) ? rawLevels.filter(Boolean) : expandLevelSelection(level);
  const isForeigner = nationality === '외국인';
  // 1-4Lv 신청자는 교육비 입금일 확인 체크박스를 체크해야 가입 가능 (강사/리더, 외국인 등은 해당 없음)
  const needsTuitionCheck = role === 'student' && !isForeigner && levels.some(l => ['1레벨', '2레벨', '3레벨', '4레벨'].includes(l));
  if (needsTuitionCheck && !tuitionDateConfirmed) {
    return { status: 400, body: { error: '교육비 입금 날짜 확인 체크박스를 확인해주세요.' } };
  }

  const [idCardUrl, bankbookUrl] = await Promise.all([
    isForeigner ? Promise.resolve(null) : uploadSignupDoc(name, '신분증', idCardPhoto),
    uploadSignupDoc(name, '통장사본', bankbookPhoto)
  ]);

  const user = db.insert('users', {
    role, phone, passwordHash: hashPassword(password), name,
    regionId: regionId || null,
    status: 'pending', // pending -> active -> inactive(퇴사/숨김)
    createdAt: new Date().toISOString(),
    securityQuestion: securityQuestion || null,
    securityAnswerHash: securityAnswer ? hashPassword(securityAnswer.trim().toLowerCase()) : null,
    profile: {
      level: levels[0] || null, levels, desiredDays: desiredDays || [],
      depositorName: depositorName || '', nationality: nationality || '내국인',
      mbti: mbti || '', disc: disc || '', career: career || '',
      firstWorkDate: firstWorkDate || '', firstWorkPeriod: yearQuarterLabel(firstWorkDate),
      debutMonth: debutMonth || '', extra: extra || '', tuitionDateConfirmed: !!tuitionDateConfirmed,
      idCardUrl, bankbookUrl
    }
  });
  // 리더(관리자)가 가입하면서 입력한 매장 주소를 해당 매장 정보에 바로 반영
  if (role === 'admin' && regionId && storeAddress) {
    db.update('regions', regionId, { address: storeAddress });
  }
  notifyRegionAdminsOfSignup(user);
  const region = regionId ? db.getById('regions', regionId) : null;
  const sheetTab = role === 'student' ? '앱_수강생' : role === 'instructor' ? '앱_강사' : '앱_리더';
  google.appendSheetRow(sheetTab, [
    new Date().toISOString(), name, depositorName || '', phone, (region ? region.name : ''),
    levels.join(','), nationality || '내국인', career || '', idCardUrl || '', bankbookUrl || ''
  ]).catch(e => console.error('Sheet sync failed (signup):', e.message));
  return { status: 200, body: { user: safeUser(user) } };
}

async function handleLogin(body, res) {
  const { phone, password, remember } = body;
  const user = db.findOne('users', u => u.phone === phone);
  if (!user || !verifyPassword(password, user.passwordHash)) return { status: 401, body: { error: '휴대폰번호 또는 비밀번호가 올바르지 않습니다.' } };
  if (user.status === 'pending') return { status: 403, body: { error: '아직 승인 대기 중입니다. 관리자 승인 후 로그인할 수 있습니다.' } };
  if (user.status === 'inactive') return { status: 403, body: { error: '비활성화된 계정입니다.' } };
  const token = createSession(user.id);
  // "자동로그인" 체크: 켜져있으면 14일 유지 쿠키, 꺼져있으면 브라우저 닫으면 사라지는 세션쿠키
  // (서버쪽 세션 자체는 항상 14일 슬라이딩으로 저장해두므로, 자동로그인 껐다가 다시 켜져도 문제 없음)
  const cookieAttrs = remember
    ? `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    : `sid=${token}; HttpOnly; Path=/; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookieAttrs);
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
      if (cookies.sid) destroySession(cookies.sid);
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJSON(res, 200, { user: safeUser(user) });
    }
    // public: needed on the signup page (before login) so users can pick their branch/region
    if (pathname === '/api/regions' && req.method === 'GET') {
      return sendJSON(res, 200, { regions: db.all('regions') });
    }

    // 비밀번호 재설정 (이메일/SMS 없이 비용 없이 처리 - 가입 시 설정한 보안질문/답변으로 본인확인)
    if (pathname === '/api/password-reset/question' && req.method === 'GET') {
      const target = db.findOne('users', u => u.phone === query.phone);
      if (!target || !target.securityQuestion) return sendJSON(res, 404, { error: '등록된 보안질문이 없습니다.' });
      return sendJSON(res, 200, { question: target.securityQuestion });
    }
    if (pathname === '/api/password-reset/confirm' && req.method === 'POST') {
      const { phone, answer, newPassword } = body;
      const target = db.findOne('users', u => u.phone === phone);
      if (!target || !target.securityAnswerHash) return sendJSON(res, 400, { error: '등록된 보안질문이 없습니다. 리더/관리자에게 초기화를 요청하세요.' });
      if (!answer || !verifyPassword(String(answer).trim().toLowerCase(), target.securityAnswerHash)) {
        return sendJSON(res, 400, { error: '답변이 일치하지 않습니다.' });
      }
      if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: '비밀번호는 4자 이상이어야 합니다.' });
      db.update('users', target.id, { passwordHash: hashPassword(newPassword) });
      return sendJSON(res, 200, { ok: true });
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
      if (query.level) students = students.filter(s => s.profile && ((s.profile.levels || []).includes(query.level) || s.profile.level === query.level));
      return sendJSON(res, 200, { students: students.map(safeUser) });
    }
    if (pathname === '/api/students/bulk-import' && req.method === 'POST') {
      if (!canApprove(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { students, regionId } = body; // raw rows straight from CSV headers (see CSV_HEADER_MAP on client)
      if (!Array.isArray(students) || !students.length) return sendJSON(res, 400, { error: '등록할 수강생 목록이 비어있습니다.' });
      const norm = v => (v || '').replace(/\s*,\s*/g, ',').trim();
      const results = [];
      students.forEach((s, idx) => {
        const name = (s.name || '').trim();
        const phone = (s.phone || '').trim();
        const weekdayRaw = (s.weekdayRaw || '').trim();
        if (!name) { results.push({ row: idx + 1, name, phone, ok: false, error: '이름 누락' }); return; }
        if (!phone) { results.push({ row: idx + 1, name, phone, ok: false, error: '휴대폰번호(아이디) 누락' }); return; }
        if (db.findOne('users', u => u.phone === phone)) { results.push({ row: idx + 1, name, phone, ok: false, error: '이미 존재하는 아이디(휴대폰번호)' }); return; }

        let status = 'active';
        let levels;
        if (weekdayRaw.includes('퇴사')) { status = 'inactive'; levels = expandLevelSelection(norm(s.levelRaw)); }
        else if (weekdayRaw.includes('이나모리')) levels = ['강사코스-이나모리'];
        else if (weekdayRaw.includes('머스크')) levels = ['강사코스-머스크'];
        else levels = expandLevelSelection(norm(s.levelRaw));

        const tempPassword = phone.replace(/\D/g, '').slice(-4) || '0000';
        const row = db.insert('users', {
          role: 'student', phone, passwordHash: hashPassword(tempPassword), name,
          regionId: regionId || null, status, createdAt: new Date().toISOString(),
          createdBy: user.id,
          profile: {
            level: levels[0] || null, levels,
            classDays: weekdayRaw && !weekdayRaw.includes('퇴사') && !weekdayRaw.includes('이나모리') && !weekdayRaw.includes('머스크') ? weekdayRaw : '',
            career: s.career || '', joinPeriod: s.joinPeriod || '', mbti: (s.mbti || '').trim(), disc: (s.disc || '').trim(),
            branch: s.branch || '', depositorName: s.depositorName || '', cohort: s.cohort || '',
            debutMonth: s.debutMonth || '', joinDate: s.joinDate || '', leaveDate: s.leaveDate || '',
            notes: s.notes || '', rrn: s.rrn || '', desiredDays: []
          }
        });
        results.push({ row: idx + 1, name, phone, level: levels.join(','), status, ok: true, tempPassword, id: row.id });
      });
      return sendJSON(res, 200, { results });
    }
    if (pathname === '/api/staff' && req.method === 'GET') {
      // instructors + admins list (for assigning leader/instructor)
      const staff = db.find('users', u => ['instructor', 'admin', 'master'].includes(u.role) && u.status === 'active');
      return sendJSON(res, 200, { staff: staff.map(safeUser) });
    }

    // ---------- REGIONS (매장) ----------
    if (pathname === '/api/regions' && req.method === 'POST') {
      if (user.role !== 'master') return sendJSON(res, 403, { error: '마스터만 매장을 추가할 수 있습니다.' });
      const { name, lat, lng, address, area, leaderName, paymentDueDay } = body;
      const region = db.insert('regions', { name, lat: lat || null, lng: lng || null, address: address || '', area: area || '', leaderName: leaderName || '', paymentDueDay: paymentDueDay || null });
      return sendJSON(res, 200, { region });
    }
    if (pathname.match(/^\/api\/regions\/\d+$/) && req.method === 'PUT') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const { name, lat, lng, address, area, leaderName, paymentDueDay } = body;
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (lat !== undefined) patch.lat = lat === '' ? null : Number(lat);
      if (lng !== undefined) patch.lng = lng === '' ? null : Number(lng);
      if (address !== undefined) patch.address = address;
      if (area !== undefined) patch.area = area;
      if (leaderName !== undefined) patch.leaderName = leaderName;
      if (paymentDueDay !== undefined) patch.paymentDueDay = paymentDueDay === '' ? null : Number(paymentDueDay);
      const region = db.update('regions', id, patch);
      return sendJSON(res, 200, { region });
    }

    // ---------- 아카데미 (수업이 실제로 진행되는 장소. 매장/리더 소속과는 별개) ----------
    if (pathname === '/api/academies' && req.method === 'GET') {
      return sendJSON(res, 200, { academies: db.all('academies') });
    }
    if (pathname === '/api/academies' && req.method === 'POST') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { name, address, lat, lng } = body;
      if (!name) return sendJSON(res, 400, { error: '아카데미 이름은 필수입니다.' });
      const row = db.insert('academies', { name, address: address || '', lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null });
      return sendJSON(res, 200, { academy: row });
    }
    if (pathname.match(/^\/api\/academies\/\d+$/) && req.method === 'PUT') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const { name, address, lat, lng } = body;
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (address !== undefined) patch.address = address;
      if (lat !== undefined) patch.lat = lat === '' ? null : Number(lat);
      if (lng !== undefined) patch.lng = lng === '' ? null : Number(lng);
      const row = db.update('academies', id, patch);
      return sendJSON(res, 200, { academy: row });
    }

    // ---------- TIMETABLE TEMPLATE ----------
    if (pathname === '/api/timetable/template' && req.method === 'GET') {
      let rows = db.all('timetable_templates');
      if (query.academyId) rows = rows.filter(r => String(r.academyId) === String(query.academyId));
      if (query.regionId) rows = rows.filter(r => String(r.regionId) === String(query.regionId));
      return sendJSON(res, 200, { templates: rows });
    }
    if (pathname === '/api/timetable/template' && req.method === 'POST') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { level, weekday, startTime, endTime, room, regionId, academyId, isInternal, title, subject, instructorId } = body;
      // 아카데미를 지정하지 않았고 등록된 아카데미가 1곳뿐이면 자동으로 그 아카데미로 연결 (출석 GPS 인증용)
      const academies = db.all('academies');
      const resolvedAcademyId = academyId || (academies.length === 1 ? academies[0].id : null);
      const row = db.insert('timetable_templates', {
        level, weekday, startTime, endTime, room, regionId, academyId: resolvedAcademyId, isInternal: !!isInternal,
        title: title || '', subject: subject || '', instructorId: instructorId || null
      });
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
      const academyId = query.academyId;
      const showInternal = query.showInternal === 'true';
      let templates = db.all('timetable_templates');
      // 시간표는 매장이 아니라 아카데미(수업 장소) 기준으로 운영된다 - 여러 매장 학생이 같은
      // 아카데미에서 함께 수업을 듣기 때문. academyId가 없으면(과거 데이터 등) 전체를 보여준다.
      if (academyId) templates = templates.filter(t => String(t.academyId) === String(academyId));
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
          const merged = Object.assign({}, t, ov ? ov.patch : {}, { date: dateStr, templateId: t.id, instanceKey: `${t.id}_${dateStr}` });
          const instructor = merged.instructorId ? db.getById('users', merged.instructorId) : null;
          merged.instructorName = instructor ? instructor.name : '';
          return merged;
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

    // ---------- 전국 해피니언 스케줄 (매장과 무관한 전국 공통 일정) ----------
    if (pathname === '/api/national-schedule' && req.method === 'GET') {
      const year = Number(query.year), month = Number(query.month);
      const nDays = daysInMonth(year, month);
      const weeklyEvents = [];
      const WEEKLY = [
        { weekday: 1, title: '전국 리더 줌미팅', start: '09:00', end: '10:00' },   // 월
        { weekday: 2, title: '전국 하퍼 줌미팅', start: '09:00', end: '10:00' },   // 화
        { weekday: 6, title: '전국 천호장 줌미팅', start: '21:00', end: '22:00' }  // 토
      ];
      for (let d = 1; d <= nDays; d++) {
        const dt = new Date(year, month - 1, d);
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        WEEKLY.forEach(w => { if (dt.getDay() === w.weekday) weeklyEvents.push({ date: dateStr, title: w.title, start: w.start, end: w.end }); });
      }
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      const itariSetting = db.findOne('app_settings', s => s.key === `itari_meeting_${monthKey}`);
      const circuit = masterCircuitSchedule(year, month).filter(c => c.date.slice(0, 7) === monthKey);
      return sendJSON(res, 200, {
        weeklyEvents,
        itariMeeting: itariSetting ? { date: itariSetting.value, title: '한국 이타리더단 미팅', start: '13:00', end: '18:00' } : null,
        circuit
      });
    }
    if (pathname === '/api/national-schedule/itari-meeting' && req.method === 'POST') {
      if (!canEditTimetable(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { year, month, date } = body;
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      const key = `itari_meeting_${monthKey}`;
      const existing = db.findOne('app_settings', s => s.key === key);
      if (existing) db.update('app_settings', existing.id, { value: date });
      else db.insert('app_settings', { key, value: date });
      return sendJSON(res, 200, { ok: true });
    }
    // 마스터/관리자용 할일 알림 (예: 이타리더단 미팅 날짜 미설정 - 매월 마지막 주 토요일까지)
    if (pathname === '/api/todos' && req.method === 'GET') {
      if (!['master', 'admin'].includes(user.role)) return sendJSON(res, 200, { todos: [] });
      const todos = [];
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth() + 1;
      const lastSat = lastSaturdayOfMonth(y, m);
      if (lastSat && todayStr() >= lastSat) {
        const key = `itari_meeting_${y}-${String(m).padStart(2, '0')}`;
        const setting = db.findOne('app_settings', s => s.key === key);
        if (!setting || !setting.value) {
          todos.push({ type: 'itari_meeting_unset', message: `${y}년 ${m}월 한국 이타리더단 미팅 날짜가 아직 설정되지 않았습니다. (매월 마지막 주 토요일까지 설정)` });
        }
      }
      return sendJSON(res, 200, { todos });
    }

    // ---------- ATTENDANCE ----------
    if (pathname === '/api/attendance' && req.method === 'GET') {
      const instanceKey = query.instanceKey;
      const rows = db.find('attendance', a => a.instanceKey === instanceKey);
      return sendJSON(res, 200, { attendance: rows });
    }
    if (pathname === '/api/attendance/check' && req.method === 'POST') {
      if (!['master', 'admin', 'instructor'].includes(user.role)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { instanceKey, period, studentId, status } = body;
      const VALID = ['출석', '보강', '지각', '조퇴', '병결', '행사', '결석'];
      if (!VALID.includes(status)) return sendJSON(res, 400, { error: '유효하지 않은 출석 상태입니다.' });
      const existing = db.findOne('attendance', a => a.instanceKey === instanceKey && a.period === period && a.studentId === studentId);
      let row;
      if (existing) row = db.update('attendance', existing.id, { status, checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'manual' });
      else row = db.insert('attendance', { instanceKey, period, studentId, status, checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'manual' });
      if (['지각', '결석'].includes(status)) notifyAttendanceIssue(row, status);
      const student = db.getById('users', studentId);
      google.appendSheetRow('앱_출석', [
        new Date().toISOString(), (student ? student.name : studentId), instanceKey, period, status, user.name
      ]).catch(e => console.error('Sheet sync failed (attendance):', e.message));
      return sendJSON(res, 200, { attendance: row });
    }
    // 교시별 출석 인증 코드. 만료 시간을 두지 않고, 강사가 다음 교시(혹은 다음 코드)를 발급하는
    // 시점까지 계속 유효하다 (수업 진행 속도가 강사마다 달라 고정 시각으로 마감할 수 없기 때문).
    // 발급 후 60초 안에 제출하면 출석, 넘으면 지각. 새 코드가 발급되면 이전 교시 미제출자는 자동 결석.
    if (pathname === '/api/attendance/checkin-code/generate' && req.method === 'POST') {
      if (!['master', 'admin', 'instructor'].includes(user.role)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { instanceKey, period } = body;
      // 같은 수업(instanceKey)에서 진행 중이던 이전 교시 코드가 있으면 마감 처리(미제출자 자동 결석)
      const prevActive = db.find('checkin_codes', c => c.instanceKey === instanceKey && c.active !== false && c.period !== period);
      prevActive.forEach(finalizeCheckinCode);
      // GPS 인증 기준은 매장이 아니라 수업이 실제로 열리는 "아카데미" 위치를 사용한다.
      const [templateId] = String(instanceKey).split('_');
      const template = db.getById('timetable_templates', templateId);
      const academies = db.all('academies');
      const academyId = (template && template.academyId) || (academies.length === 1 ? academies[0].id : null);
      const code = randomCode(6);
      const row = db.insert('checkin_codes', {
        instanceKey, period, academyId, code,
        issuedAt: Date.now(), active: true, createdBy: user.id
      });
      return sendJSON(res, 200, { code: row.code, issuedAt: row.issuedAt, lateAfterMs: LATE_THRESHOLD_MS });
    }
    if (pathname === '/api/attendance/checkin-code/submit' && req.method === 'POST') {
      if (user.role !== 'student') return sendJSON(res, 403, { error: '수강생만 사용할 수 있습니다.' });
      const { code, lat, lng } = body;
      const session = [...db.all('checkin_codes')].reverse().find(c => c.code === code && c.active !== false);
      if (!session) return sendJSON(res, 400, { error: '유효하지 않거나 마감된 코드입니다. 강사에게 다시 확인하세요.' });
      if (lat === undefined || lng === undefined) return sendJSON(res, 400, { error: '위치 정보가 필요합니다.' });
      const academy = session.academyId ? db.getById('academies', session.academyId) : null;
      if (!academy || academy.lat === undefined || academy.lat === null || academy.lng === undefined || academy.lng === null) {
        return sendJSON(res, 400, { error: '아카데미 위치 정보가 아직 설정되지 않았습니다. 관리자에게 아카데미 GPS 좌표 등록을 요청하세요.' });
      }
      const dist = distanceMeters(lat, lng, academy.lat, academy.lng);
      if (dist > CHECKIN_RADIUS_M) return sendJSON(res, 400, { error: `아카데미 위치에서 너무 멉니다 (약 ${Math.round(dist)}m). 강사에게 수동 체크를 요청하세요.` });
      const isLate = (Date.now() - session.issuedAt) > LATE_THRESHOLD_MS;
      const status = isLate ? '지각' : '출석';
      const existing = db.findOne('attendance', a => a.instanceKey === session.instanceKey && a.period === session.period && a.studentId === user.id);
      let row;
      const payload = { status, checkedBy: user.id, checkedAt: new Date().toISOString(), method: 'checkin_code' };
      if (existing) row = db.update('attendance', existing.id, payload);
      else row = db.insert('attendance', Object.assign({ instanceKey: session.instanceKey, period: session.period, studentId: user.id }, payload));
      if (isLate) notifyAttendanceIssue(row, '지각');
      return sendJSON(res, 200, { attendance: row });
    }
    if (pathname === '/api/attendance/stats' && req.method === 'GET') {
      const STATUSES = ['출석', '보강', '지각', '조퇴', '병결', '행사', '결석'];
      let students = db.find('users', u => u.role === 'student' && u.status === 'active');
      if (query.regionId) students = students.filter(s => String(s.regionId) === String(query.regionId));
      if (query.level) students = students.filter(s => s.profile && ((s.profile.levels || []).includes(query.level) || s.profile.level === query.level));
      if (query.studentId) students = students.filter(s => String(s.id) === String(query.studentId));
      const allAttendance = db.all('attendance');
      const EXAM_MONTHS = [3, 6, 9, 12];
      const thresholdSetting = db.findOne('app_settings', s => s.key === 'exam_attendance_threshold');
      const threshold = thresholdSetting ? Number(thresholdSetting.value) : null; // null = 아직 미설정, 경고 없음
      const isExamMonth = EXAM_MONTHS.includes(new Date().getMonth() + 1);
      const stats = students.map(s => {
        const rows = allAttendance.filter(a => a.studentId === s.id);
        const total = rows.length;
        const counts = {}; STATUSES.forEach(st => counts[st] = 0);
        rows.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
        const percents = {};
        STATUSES.forEach(st => percents[st] = total ? Math.round((counts[st] / total) * 1000) / 10 : 0);
        const examWarning = !!(threshold !== null && isExamMonth && total && percents['출석'] < threshold);
        return { student: safeUser(s), total, counts, percents, examWarning, examThreshold: threshold };
      });
      return sendJSON(res, 200, { stats, examThreshold: threshold, isExamMonth });
    }
    // 매장별 출석률 집계 (관리자/마스터)
    if (pathname === '/api/attendance/stats-by-store' && req.method === 'GET') {
      if (!isAtLeast(user, 'admin')) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const STATUSES = ['출석', '보강', '지각', '조퇴', '병결', '행사', '결석'];
      const students = db.find('users', u => u.role === 'student' && u.status === 'active');
      const allAttendance = db.all('attendance');
      const regions = db.all('regions');
      const byStore = regions.map(r => {
        const storeStudents = students.filter(s => String(s.regionId) === String(r.id));
        const studentIds = storeStudents.map(s => s.id);
        const rows = allAttendance.filter(a => studentIds.includes(a.studentId));
        const total = rows.length;
        const counts = {}; STATUSES.forEach(st => counts[st] = 0);
        rows.forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });
        const percents = {};
        STATUSES.forEach(st => percents[st] = total ? Math.round((counts[st] / total) * 1000) / 10 : 0);
        return { regionId: r.id, regionName: r.name, area: r.area, studentCount: storeStudents.length, total, counts, percents };
      });
      return sendJSON(res, 200, { byStore });
    }

    // ---------- 설정값 (마스터 전용 - 진화시험 출석률 기준 등, 임의로 값을 만들지 않고 마스터가 직접 입력) ----------
    if (pathname.match(/^\/api\/settings\/[\w-]+$/) && req.method === 'GET') {
      const key = pathname.split('/')[3];
      const row = db.findOne('app_settings', s => s.key === key);
      return sendJSON(res, 200, { key, value: row ? row.value : null });
    }
    if (pathname.match(/^\/api\/settings\/[\w-]+$/) && req.method === 'POST') {
      if (user.role !== 'master') return sendJSON(res, 403, { error: '마스터만 설정을 변경할 수 있습니다.' });
      const key = pathname.split('/')[3];
      const { value } = body;
      const row = db.findOne('app_settings', s => s.key === key);
      if (row) db.update('app_settings', row.id, { value });
      else db.insert('app_settings', { key, value });
      return sendJSON(res, 200, { key, value });
    }

    // ---------- 수업종료(class session) ----------
    if (pathname === '/api/class-sessions/end' && req.method === 'POST') {
      if (!['master', 'admin', 'instructor'].includes(user.role)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const { instanceKey, period } = body;
      const existing = db.findOne('class_sessions', c => c.instanceKey === instanceKey && c.period === period);
      const row = existing
        ? db.update('class_sessions', existing.id, { endedAt: new Date().toISOString(), endedBy: user.id })
        : db.insert('class_sessions', { instanceKey, period, endedAt: new Date().toISOString(), endedBy: user.id });
      return sendJSON(res, 200, { session: row });
    }
    if (pathname === '/api/class-sessions' && req.method === 'GET') {
      const rows = query.instanceKey ? db.find('class_sessions', c => c.instanceKey === query.instanceKey) : db.all('class_sessions');
      return sendJSON(res, 200, { sessions: rows });
    }
    // 오늘 종료된 수업 중, 나(강사)의 피드백이 아직 다 안 채워진 수강생 수 (당일 완료 유도 배너용)
    if (pathname === '/api/feedback/pending-today' && req.method === 'GET') {
      if (!canWriteInstructorFeedback(user)) return sendJSON(res, 200, { pending: 0, items: [] });
      const today = todayStr();
      const endedToday = db.find('class_sessions', c => c.endedBy === user.id && String(c.endedAt || '').slice(0, 10) === today);
      const fb = db.all('feedback_instructor');
      const items = [];
      endedToday.forEach(sess => {
        const [templateId] = String(sess.instanceKey).split('_');
        const template = db.getById('timetable_templates', templateId);
        const enrolled = getEnrolledStudents(template);
        enrolled.forEach(stu => {
          const has = fb.some(f => f.instanceKey === sess.instanceKey && String(f.studentId) === String(stu.id) && String(f.authorId) === String(user.id));
          if (!has) items.push({ instanceKey: sess.instanceKey, period: sess.period, studentId: stu.id, studentName: stu.name });
        });
      });
      return sendJSON(res, 200, { pending: items.length, items });
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
      const { title, description, level, weekday, deadline, submissionType, regionId, targetCount } = body;
      if (!title || !deadline) return sendJSON(res, 400, { error: '제목과 마감일은 필수입니다.' });
      const row = db.insert('assignments', {
        title, description: description || '', level: level || null, weekday: weekday || null,
        deadline, submissionType: submissionType || 'none', regionId: regionId || null,
        targetCount: submissionType === 'model_work' ? (Number(targetCount) || 100) : null,
        createdBy: user.id, createdAt: new Date().toISOString()
      });
      return sendJSON(res, 200, { assignment: row });
    }
    if (pathname === '/api/assignments' && req.method === 'GET') {
      let rows = db.all('assignments');
      if (user.role === 'student') {
        const myLevels = (user.profile && user.profile.levels) || [];
        rows = rows.filter(a => !a.level || myLevels.includes(a.level));
      } else if (query.level) {
        rows = rows.filter(a => !a.level || a.level === query.level);
      }
      if (query.weekday) rows = rows.filter(a => !a.weekday || a.weekday === query.weekday);
      if (query.regionId) rows = rows.filter(a => !a.regionId || String(a.regionId) === String(query.regionId));
      const subs = db.all('assignment_submissions');
      const modelLogs = db.all('model_work_logs');
      rows = rows.map(a => {
        if (a.submissionType === 'model_work') {
          const myCount = user.role === 'student' ? modelLogs.filter(l => l.assignmentId === a.id && l.studentId === user.id).length : undefined;
          return Object.assign({}, a, { myModelWorkCount: myCount, modelWorkTotalCount: modelLogs.filter(l => l.assignmentId === a.id).length });
        }
        return Object.assign({}, a, {
          mySubmission: user.role === 'student' ? (subs.find(s => s.assignmentId === a.id && s.studentId === user.id) || null) : undefined,
          submissionCount: subs.filter(s => s.assignmentId === a.id).length
        });
      });
      return sendJSON(res, 200, { assignments: rows });
    }

    // ---------- 모델 작업 (비포/애프터, 진화 필수 과제 등 누적형) ----------
    if (pathname === '/api/model-work/submit' && req.method === 'POST') {
      if (user.role !== 'student') return sendJSON(res, 403, { error: '수강생만 등록할 수 있습니다.' });
      const { assignmentId, beforePhoto, afterPhoto, comment } = body;
      const assignment = db.getById('assignments', assignmentId);
      if (!assignment) return sendJSON(res, 404, { error: '과제를 찾을 수 없습니다.' });
      const [beforeUrl, afterUrl] = await Promise.all([
        uploadSignupDoc(user.name, '모델작업_비포', beforePhoto),
        uploadSignupDoc(user.name, '모델작업_애프터', afterPhoto)
      ]);
      const row = db.insert('model_work_logs', {
        assignmentId, studentId: user.id, beforePhotoUrl: beforeUrl, afterPhotoUrl: afterUrl,
        comment: comment || '', feedbacks: [], aiFeedback: null, createdAt: new Date().toISOString()
      });
      const countSoFar = db.find('model_work_logs', l => l.assignmentId === assignmentId && l.studentId === user.id).length;
      return sendJSON(res, 200, { log: row, count: countSoFar, target: assignment.targetCount || 100 });
    }
    if (pathname === '/api/model-work' && req.method === 'GET') {
      let rows = db.all('model_work_logs');
      if (query.assignmentId) rows = rows.filter(l => String(l.assignmentId) === String(query.assignmentId));
      if (user.role === 'student') rows = rows.filter(l => String(l.studentId) === String(user.id));
      else if (query.studentId) rows = rows.filter(l => String(l.studentId) === String(query.studentId));
      rows = rows.map(l => Object.assign({}, l, { studentName: (db.getById('users', l.studentId) || {}).name }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJSON(res, 200, { logs: rows });
    }
    if (pathname.match(/^\/api\/model-work\/\d+\/feedback$/) && req.method === 'POST') {
      if (!canWriteInstructorFeedback(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const { comment } = body;
      if (!comment) return sendJSON(res, 400, { error: '내용을 입력하세요.' });
      const log = db.getById('model_work_logs', id);
      if (!log) return sendJSON(res, 404, { error: 'not found' });
      const feedbacks = log.feedbacks || [];
      feedbacks.push({ comment, authorId: user.id, authorName: user.name, createdAt: new Date().toISOString() });
      const row = db.update('model_work_logs', id, { feedbacks });
      return sendJSON(res, 200, { log: row });
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
        // Render 등 무료 호스팅은 로컬 디스크가 재배포/재시작 시 초기화되므로, 제출 파일은
        // 로컬 대신 구글 드라이브에 저장하고 그 링크를 취합 시트/제출현황에 남긴다.
        const ext = (fileName && fileName.includes('.')) ? fileName.split('.').pop() : 'dat';
        const driveFileName = `${user.name}_${assignment.title}_${todayStr().replace(/-/g, '')}.${ext}`;
        try {
          const uploaded = await google.uploadToDrive(driveFileName, 'application/octet-stream', fileData);
          storedPath = uploaded ? uploaded.webViewLink : null;
        } catch (e) { console.error('과제 파일 드라이브 업로드 실패:', e.message); }
        if (!storedPath) {
          // 구글 연동이 안 되어있을 때를 위한 폴백 (로컬 저장, 재배포 시 유실될 수 있음)
          const buf = Buffer.from(fileData, 'base64');
          const safeName = `${Date.now()}_${user.id}_${(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
          storedPath = `/uploads/${safeName}`;
        }
      }
      const existing = db.findOne('assignment_submissions', s => s.assignmentId === assignmentId && s.studentId === user.id);
      const payload = {
        type, content: type === 'link' ? content : storedPath, comment: comment || '',
        completedAt: new Date().toISOString()
      };
      let row;
      if (existing) row = db.update('assignment_submissions', existing.id, payload);
      else row = db.insert('assignment_submissions', Object.assign({ assignmentId, studentId: user.id }, payload));
      google.appendSheetRow('앱_과제제출', [
        new Date().toISOString(), assignment.title, user.name, type, payload.content || '', comment || ''
      ]).catch(e => console.error('Sheet sync failed (assignment submit):', e.message));
      return sendJSON(res, 200, { submission: row });
    }
    if (pathname === '/api/notifications/mine' && req.method === 'GET') {
      const rows = db.find('notifications', n => n.targetUserId === user.id && !n.read)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJSON(res, 200, { notifications: rows });
    }
    if (pathname.match(/^\/api\/notifications\/\d+\/read$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const n = db.getById('notifications', id);
      if (n && n.targetUserId === user.id) db.update('notifications', id, { read: true });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/notifications/assignments' && req.method === 'GET') {
      // D-1 / D-2 마감 임박 알림. 대상: 수강생 본인, 과제를 등록한 강사/관리자, 대상 수강생의 매장 리더
      const rows = db.all('assignments');
      const today = new Date(todayStr());
      const relevant = rows.filter(a => {
        const dl = new Date((a.deadline || '').slice(0, 10));
        const diffDays = Math.round((dl - today) / (1000 * 60 * 60 * 24));
        if (diffDays !== 0 && diffDays !== 1 && diffDays !== 2) return false;
        if (user.role === 'student') {
          return !a.level || ((user.profile && user.profile.levels) || []).includes(a.level);
        }
        if (String(a.createdBy) === String(user.id)) return true; // 등록한 강사/관리자 본인
        if (user.role === 'admin') {
          // 이 매장 소속 수강생이 대상인 과제인지 (지역 지정이 있으면 지역으로, 없으면 레벨로 판단)
          if (a.regionId) return String(a.regionId) === String(user.regionId);
          return true;
        }
        return false;
      }).map(a => {
        const dl = new Date((a.deadline || '').slice(0, 10));
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
      const student = db.getById('users', studentId);
      google.appendSheetRow('앱_결제', [
        new Date().toISOString(), (student ? student.name : studentId), depositorName, amount,
        isDeferred ? '후불' : '', insts.length, user.name
      ]).catch(e => console.error('Sheet sync failed (payment):', e.message));
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

    // ---------- 월별 회비 현황 (자동 생성) ----------
    // 1-4Lv/강사코스/세미나 대상 재원생에 대해 매달 항목을 자동으로 만들어둔다. 금액은 임의로
    // 정하지 않고 비워둔 채 생성하며, 관리자가 직접 입력/확인만 하면 된다.
    if (pathname === '/api/monthly-dues' && req.method === 'GET') {
      if (!canManagePayments(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const month = query.month || todayStr().slice(0, 7);
      const amountSetting = db.findOne('app_settings', s => s.key === 'monthly_tuition_amount');
      const defaultAmount = amountSetting && amountSetting.value !== null && amountSetting.value !== '' ? Number(amountSetting.value) : null;
      let students = db.find('users', u => u.role === 'student' && u.status === 'active');
      students = students.filter(s => s.profile && (s.profile.levels || []).some(l => BILLABLE_LEVELS.includes(l)));
      if (query.regionId) students = students.filter(s => String(s.regionId) === String(query.regionId));
      students.forEach(s => {
        const exists = db.findOne('monthly_dues', d => d.month === month && String(d.studentId) === String(s.id));
        if (exists) return;
        const region = s.regionId ? db.getById('regions', s.regionId) : null;
        let dueDate = null;
        if (region && region.paymentDueDay) {
          dueDate = `${month}-${String(region.paymentDueDay).padStart(2, '0')}`;
        }
        db.insert('monthly_dues', {
          month, studentId: s.id, regionId: s.regionId || null, dueDate,
          amount: defaultAmount, paid: false, paidDate: null, updatedBy: null, updatedAt: new Date().toISOString()
        });
      });
      let rows = db.find('monthly_dues', d => d.month === month);
      if (query.regionId) rows = rows.filter(d => String(d.regionId) === String(query.regionId));
      rows = rows.map(d => {
        const s = db.getById('users', d.studentId);
        return Object.assign({}, d, { studentName: s ? s.name : '', levels: s && s.profile ? s.profile.levels : [], regionName: (d.regionId && db.getById('regions', d.regionId) || {}).name || '' });
      });
      const bankSetting = db.findOne('app_settings', s => s.key === 'tuition_bank_account');
      return sendJSON(res, 200, { dues: rows, bankAccount: bankSetting ? bankSetting.value : null });
    }
    if (pathname.match(/^\/api\/monthly-dues\/\d+$/) && req.method === 'POST') {
      if (!canManagePayments(user)) return sendJSON(res, 403, { error: '권한이 없습니다.' });
      const id = pathname.split('/')[3];
      const { amount, paid, paidDate, dueDate } = body;
      const patch = { updatedBy: user.id, updatedAt: new Date().toISOString() };
      if (amount !== undefined) patch.amount = amount === '' ? null : Number(amount);
      if (dueDate !== undefined) patch.dueDate = dueDate;
      if (paid !== undefined) { patch.paid = !!paid; patch.paidDate = paid ? (paidDate || todayStr()) : null; }
      const row = db.update('monthly_dues', id, patch);
      return sendJSON(res, 200, { due: row });
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
