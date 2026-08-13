// 마스터 계정 + 매장(지역) 목록만 시드로 만들어둔다.
// 리더(관리자) 계정은 각자 회원가입 -> 마스터 승인으로 생성하는 방식으로 정했으므로
// 여기서 임의로 계정을 만들지 않는다. 시간표 기본틀, 과목, 강사 배정도 마찬가지로
// 실제 운영자가 직접 입력해야 하는 값이라 여기서 채우지 않는다.
// Run once: `npm run seed` (safe to re-run; skips if data already exists).
const db = require('./lib/db');
const { hashPassword } = require('./lib/auth');

// 지원님이 알려준 실제 매장/리더 목록. 주소·GPS좌표·입금예정일(수원/인천)은 아직 정해지지
// 않은 값이라 비워두고, 대시보드의 "매장 관리" 화면에서 직접 입력/수정할 수 있게 한다.
const STORES = [
  { area: '강남', name: '압구정 플래그십', leaderName: '엘맘', paymentDueDay: 10 },
  { area: '강남', name: '압구정 로데오역', leaderName: '헤더', paymentDueDay: 10 },
  { area: '강남', name: '압구정 엘', leaderName: '조이', paymentDueDay: 10 },
  { area: '강남', name: '강남구청 스타트', leaderName: '테리', paymentDueDay: 10 },
  { area: '강남', name: '강남 이도', leaderName: '이도사', paymentDueDay: 10 },
  { area: '강남', name: '강남 모나코', leaderName: '이타', paymentDueDay: 10 },
  { area: '강남', name: '강남 미라클', leaderName: '건', paymentDueDay: 10 },
  { area: '강남', name: '강남 시크릿', leaderName: '하이', paymentDueDay: 10 },
  { area: '강서', name: '강서 우장산', leaderName: '슬기', paymentDueDay: 10 },
  { area: '강서', name: '강서 마곡', leaderName: '강윤', paymentDueDay: 10 },
  { area: '강서', name: '강서 발산', leaderName: '윈터', paymentDueDay: 10 },
  { area: '강서', name: '강서 우장마음', leaderName: '고맘', paymentDueDay: 10 },
  { area: '수원', name: '수원시청', leaderName: '선주', paymentDueDay: null },
  { area: '인천', name: '구월우리', leaderName: '우리', paymentDueDay: null }
];

function run() {
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

  let createdCount = 0;
  STORES.forEach(s => {
    const exists = db.findOne('regions', r => r.name === s.name);
    if (exists) return;
    db.insert('regions', {
      name: s.name, area: s.area, leaderName: s.leaderName, paymentDueDay: s.paymentDueDay,
      address: '', lat: null, lng: null
    });
    createdCount++;
  });
  if (createdCount) console.log(`매장(지역) ${createdCount}개 등록됨 (주소/GPS좌표는 매장 관리 화면에서 입력 필요)`);

  console.log('\nSeed complete.');
}

run();
