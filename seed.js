// Seeds a starter master account, one region, and a basic timetable template.
// Run once: `npm run seed` (safe to re-run; skips if master already exists).
const db = require('./lib/db');
const { hashPassword } = require('./lib/auth');

function run() {
  let region = db.findOne('regions', r => r.name === '압구정');
  if (!region) {
    region = db.insert('regions', { name: '압구정', address: '서울 강남구 압구정로 332', lat: 37.5274, lng: 127.0400 });
    console.log('region created:', region.name);
  }

  // NOTE: master ID/password below are the requested credentials (happynian).
  // This block upserts so a redeploy always keeps the master account in sync,
  // even on Render's free tier where the data file can reset.
  const MASTER_PHONE = 'happynian';
  const MASTER_PASSWORD = 'rlatnsejr1!';
  let master = db.findOne('users', u => u.role === 'master');
  if (!master) {
    master = db.insert('users', {
      role: 'master', phone: MASTER_PHONE, passwordHash: hashPassword(MASTER_PASSWORD),
      name: '마스터', regionId: null, status: 'active', createdAt: new Date().toISOString(),
      profile: {}
    });
    console.log(`master account created — id: ${MASTER_PHONE} / password: ${MASTER_PASSWORD}`);
  } else if (master.phone !== MASTER_PHONE) {
    db.update('users', master.id, { phone: MASTER_PHONE, passwordHash: hashPassword(MASTER_PASSWORD) });
    console.log(`master account synced — id: ${MASTER_PHONE} / password: ${MASTER_PASSWORD}`);
  }

  let regionRep = db.findOne('users', u => u.role === 'region_rep' && u.regionId === region.id);
  if (!regionRep) {
    regionRep = db.insert('users', {
      role: 'region_rep', phone: '01011111111', passwordHash: hashPassword('rep1234'),
      name: '압구정 지역대표', regionId: region.id, status: 'active', createdAt: new Date().toISOString(),
      profile: {}
    });
    console.log('region_rep account created — phone: 01011111111 / password: rep1234');
  }

  let admin = db.findOne('users', u => u.role === 'admin' && u.regionId === region.id);
  if (!admin) {
    admin = db.insert('users', {
      role: 'admin', phone: '01022222222', passwordHash: hashPassword('admin1234'),
      name: '압구정 관리자', regionId: region.id, status: 'active', createdAt: new Date().toISOString(),
      profile: {}
    });
    console.log('admin account created — phone: 01022222222 / password: admin1234');
  }

  // 시간표 틀(요일/레벨/시간)만 기본 제공. 과목명·강사 배정은 실제 운영자가
  // 관리자 화면(시간표 관리)에서 직접 입력해야 하므로 빈 값으로 둔다 — 임의로 채우지 않음.
  const templates = db.find('timetable_templates', t => t.regionId === region.id);
  if (!templates.length) {
    // 학원은 월~목만 운영, 요일별로 레벨 2~3개가 함께 돌아간다 (예: 월 = 1,3레벨 + 가끔 강사코스)
    const rows = [
      { level: '1레벨', weekday: '월', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '1레벨', subject: '', instructorId: null },
      { level: '3레벨', weekday: '월', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '3레벨', subject: '', instructorId: null },
      { level: '2레벨', weekday: '화', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '2레벨', subject: '', instructorId: null },
      { level: '4레벨', weekday: '화', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '4레벨', subject: '', instructorId: null },
      { level: '강사코스-이나모리', weekday: '화', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '강사코스-이나모리반', subject: '', instructorId: null },
      { level: '1레벨', weekday: '수', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '1레벨', subject: '', instructorId: null },
      { level: '3레벨', weekday: '수', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '3레벨', subject: '', instructorId: null },
      { level: '강사코스-머스크', weekday: '수', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '강사코스-머스크반', subject: '', instructorId: null },
      { level: '2레벨', weekday: '목', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '2레벨', subject: '', instructorId: null },
      { level: '4레벨', weekday: '목', startTime: '10:00', endTime: '18:00', room: '', regionId: region.id, isInternal: false, title: '4레벨', subject: '', instructorId: null },
      { level: null, weekday: '월', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '리더 줌미팅', subject: '', instructorId: null },
      { level: null, weekday: '화', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '하이퍼포머 줌미팅', subject: '', instructorId: null }
    ];
    rows.forEach(r => db.insert('timetable_templates', r));
    console.log(`timetable templates seeded: ${rows.length}`);
  }

  console.log('\nSeed complete.');
}

run();
