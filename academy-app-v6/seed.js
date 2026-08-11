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

  // demo instructors, so the timetable can show a real "강사 이름" without a click
  let ins1 = db.findOne('users', u => u.role === 'instructor' && u.phone === '01033330001');
  if (!ins1) {
    ins1 = db.insert('users', {
      role: 'instructor', phone: '01033330001', passwordHash: hashPassword('teach1234'),
      name: '이도', regionId: region.id, status: 'active', createdAt: new Date().toISOString(), profile: {}
    });
    console.log('instructor account created — phone: 01033330001 / password: teach1234 (이도)');
  }
  let ins2 = db.findOne('users', u => u.role === 'instructor' && u.phone === '01033330002');
  if (!ins2) {
    ins2 = db.insert('users', {
      role: 'instructor', phone: '01033330002', passwordHash: hashPassword('teach1234'),
      name: '건', regionId: region.id, status: 'active', createdAt: new Date().toISOString(), profile: {}
    });
    console.log('instructor account created — phone: 01033330002 / password: teach1234 (건)');
  }

  const templates = db.find('timetable_templates', t => t.regionId === region.id);
  if (!templates.length) {
    // 학원은 월~목만 운영, 요일별로 레벨 2~3개가 함께 돌아간다 (예: 월 = 1,3레벨 + 가끔 강사코스)
    const rows = [
      { level: '1레벨', weekday: '월', startTime: '11:00', endTime: '18:00', room: 'A', regionId: region.id, isInternal: false, title: '1레벨 (비기너)', subject: '펌 이론', instructorId: ins1.id },
      { level: '3레벨', weekday: '월', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '3레벨 (챌린저)', subject: '커트 실습', instructorId: ins2.id },
      { level: '2레벨', weekday: '화', startTime: '11:00', endTime: '18:00', room: 'A', regionId: region.id, isInternal: false, title: '2레벨 (러너)', subject: '컬러 이론', instructorId: ins1.id },
      { level: '4레벨', weekday: '화', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '4레벨 (워너)', subject: '스타일링', instructorId: ins2.id },
      { level: '강사코스-이나모리', weekday: '화', startTime: '10:00', endTime: '17:00', room: 'C', regionId: region.id, isInternal: false, title: '강사코스-이나모리반', subject: '강사 양성', instructorId: ins1.id },
      { level: '1레벨', weekday: '수', startTime: '11:00', endTime: '18:00', room: 'A', regionId: region.id, isInternal: false, title: '1레벨 (비기너)', subject: '펌 실습', instructorId: ins1.id },
      { level: '3레벨', weekday: '수', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '3레벨 (챌린저)', subject: '커트 이론', instructorId: ins2.id },
      { level: '강사코스-머스크', weekday: '수', startTime: '10:00', endTime: '17:00', room: 'C', regionId: region.id, isInternal: false, title: '강사코스-머스크반', subject: '강사 양성', instructorId: ins2.id },
      { level: '2레벨', weekday: '목', startTime: '11:00', endTime: '18:00', room: 'A', regionId: region.id, isInternal: false, title: '2레벨 (러너)', subject: '컬러 실습', instructorId: ins1.id },
      { level: '4레벨', weekday: '목', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '4레벨 (워너)', subject: '스타일링 실습', instructorId: ins2.id },
      { level: null, weekday: '월', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '리더 줌미팅', subject: '', instructorId: null },
      { level: null, weekday: '화', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '하이퍼포머 줌미팅', subject: '', instructorId: null }
    ];
    rows.forEach(r => db.insert('timetable_templates', r));
    console.log(`timetable templates seeded: ${rows.length}`);
  }

  console.log('\nSeed complete.');
}

run();
