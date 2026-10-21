const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const todayStr = (now = new Date()) => dateStr(now);

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

function isFree(db, profId, date, start, duration) {
  return !db.appointments.some(
    (a) =>
      a.professionalId === profId &&
      a.date === date &&
      a.status !== 'cancelado' &&
      start < a.start + a.duration &&
      a.start < start + duration
  );
}

/** Motivo pelo qual o dia não aceita agendamentos, ou null se está aberto. */
function closedReason(db, date, now = new Date()) {
  const s = db.settings;
  if (!isValidDate(date)) return 'Data inválida';
  if (date < todayStr(now)) return 'Data passada';
  if (date > addDays(todayStr(now), s.maxDaysAhead)) return `Agenda aberta só para os próximos ${s.maxDaysAhead} dias`;
  const block = db.blocks.find((b) => b.date === date);
  if (block) return block.reason || 'Salão fechado neste dia';
  if (!s.openDays.includes(new Date(date + 'T00:00:00').getDay())) return 'Não atendemos neste dia da semana';
  return null;
}

/** Retorna [{ time, professionalId }] livres para o serviço na data. professionalId 0 = qualquer. */
function getSlots(db, { date, serviceId, professionalId }, now = new Date()) {
  const s = db.settings;
  const service = db.services.find((x) => x.id === serviceId);
  if (!service || closedReason(db, date, now)) return [];

  let pros = db.professionals;
  if (professionalId) pros = pros.filter((p) => p.id === professionalId);
  if (!pros.length) return [];

  const open = toMin(s.openTime);
  const close = toMin(s.closeTime);
  const lunch = s.lunchStart && s.lunchEnd ? [toMin(s.lunchStart), toMin(s.lunchEnd)] : null;
  const earliest = now.getTime() + s.minNoticeHours * 3600 * 1000;
  const dayStart = new Date(date + 'T00:00:00').getTime();

  const out = [];
  for (let t = open; t + service.duration <= close; t += s.slotMinutes) {
    if (dayStart + t * 60000 < earliest) continue;
    if (lunch && t < lunch[1] && t + service.duration > lunch[0]) continue;
    const pro = pros.find((p) => isFree(db, p.id, date, t, service.duration));
    if (pro) out.push({ time: toHM(t), professionalId: pro.id });
  }
  return out;
}

module.exports = { toMin, toHM, isValidDate, todayStr, dateStr, addDays, closedReason, getSlots };
