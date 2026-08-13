function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function weekdayKo(dateStr) {
  const names = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(dateStr + 'T00:00:00');
  return names[d.getDay()];
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 그 달의 마지막 토요일 날짜(YYYY-MM-DD)
function lastSaturdayOfMonth(year, month) {
  const n = daysInMonth(year, month);
  for (let d = n; d >= 1; d--) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === 6) return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// "스승님 심연 스케줄" 순회 일정 계산.
// 규칙: 1일이 무슨 요일이든, 월~금이 모두 포함되는 첫 번째 주(=1일이 월요일이 아니면 그 첫 주는
// 건너뛰고 다음 월요일부터 시작하는 주)를 "첫째주"로 본다. 이후 순서:
// 첫째주 화(제주) -> 첫째주 목(강남) -> 첫째주 금(제천) -> 둘째주 일(강서, 첫째주 금요일 이틀 뒤)
// -> 둘째주 월(부산) -> 화(울산) -> 수(대구) -> 목(목포)
function masterCircuitSchedule(year, month) {
  const n = daysInMonth(year, month);
  let firstMonday = null;
  for (let d = 1; d <= n; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === 1) { firstMonday = d; break; }
  }
  if (firstMonday === null) return [];
  const fmt = (day) => {
    // day may overflow into next month; use Date to normalize
    const dt = new Date(year, month - 1, day);
    const y = dt.getFullYear(), m = dt.getMonth() + 1, dd = dt.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };
  const plan = [
    { offset: 1, city: '제주' },   // 첫째주 화
    { offset: 3, city: '강남' },   // 첫째주 목
    { offset: 4, city: '제천' },   // 첫째주 금
    { offset: 6, city: '강서' },   // 둘째주 일
    { offset: 7, city: '부산' },   // 둘째주 월
    { offset: 8, city: '울산' },   // 둘째주 화
    { offset: 9, city: '대구' },   // 둘째주 수
    { offset: 10, city: '목포' }   // 둘째주 목
  ];
  return plan.map(p => ({ date: fmt(firstMonday + p.offset), city: p.city }));
}

// 첫 출근일 기준 연도/분기 자동 구분 (예: "2026년 1분기")
function yearQuarterLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}년 ${q}분기`;
}

module.exports = { distanceMeters, todayStr, weekdayKo, daysInMonth, lastSaturdayOfMonth, masterCircuitSchedule, yearQuarterLabel };
