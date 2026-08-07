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

  const templates = db.find('timetable_templates', t => t.regionId === region.id);
  if (!templates.length) {
    const rows = [
      { level: '1Lv(베이직)', weekday: '월', startTime: '19:00', endTime: '21:00', room: 'A', regionId: region.id, isInternal: false, title: '1Lv 베이직' },
      { level: '2Lv(베이직)', weekday: '화', startTime: '19:00', endTime: '21:00', room: 'A', regionId: region.id, isInternal: false, title: '2Lv 베이직' },
      { level: '1Lv(베이직)', weekday: '수', startTime: '19:00', endTime: '21:00', room: 'A', regionId: region.id, isInternal: false, title: '1Lv 베이직' },
      { level: '2Lv(베이직)', weekday: '목', startTime: '19:00', endTime: '21:00', room: 'A', regionId: region.id, isInternal: false, title: '2Lv 베이직' },
      { level: '3Lv(우먼)', weekday: '월', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '3Lv 우먼' },
      { level: '4Lv(맨즈)', weekday: '화', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '4Lv 맨즈' },
      { level: '3Lv(우먼)', weekday: '수', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '3Lv 우먼' },
      { level: '4Lv(맨즈)', weekday: '목', startTime: '11:00', endTime: '18:00', room: 'B', regionId: region.id, isInternal: false, title: '4Lv 맨즈' },
      { level: null, weekday: '월', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '리더 줌미팅' },
      { level: null, weekday: '화', startTime: '09:00', endTime: '10:00', room: '', regionId: region.id, isInternal: true, title: '하이퍼포머 줌미팅' }
    ];
    rows.forEach(r => db.insert('timetable_templates', r));
    console.log(`timetable templates seeded: ${rows.length}`);
  }

  console.log('\nSeed complete.');
}

run();
