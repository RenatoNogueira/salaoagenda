// Datas e horários do salão. IMPORTANTE: tudo é calculado no fuso do salão (padrão America/Sao_Paulo, ou APP_TIMEZONE),
// e não no fuso do servidor. Na Vercel o servidor roda em UTC (3 horas à frente de Brasília): sem isso, "hoje" virava
// "amanhã" depois das 21h e os horários de hoje eram avaliados com 3 horas de diferença.
const TZ = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Data (YYYY-MM-DD) e minutos desde 00:00 de um instante, no fuso do salão. */
function nowParts(now = new Date()) {
  const o = {};
  for (const p of partsFmt.formatToParts(now)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}

const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toHM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

/** Data (YYYY-MM-DD) de um instante no fuso do salão. */
const dateStr = (d) => nowParts(d).date;
const todayStr = (now = new Date()) => nowParts(now).date;

// Aritmética de datas "de calendário": feita em UTC, então não depende do fuso nem de horário de verão.
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
const weekdayOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = domingo

/** Hora (HH:MM) de um instante, no fuso do salão. */
function timeStr(d) {
  const { minutes } = nowParts(d);
  return toHM(minutes);
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
  if (!s.openDays.includes(weekdayOf(date))) return 'Não atendemos neste dia da semana';
  return null;
}

/** Retorna [{ time, professionalId, free }] para o serviço na data. professionalId 0 = qualquer.
 *  Por padrão só os horários livres; com all: true inclui também os já ocupados (free: false). */
function getSlots(db, { date, serviceId, professionalId, all = false }, now = new Date()) {
  const s = db.settings;
  const service = db.services.find((x) => x.id === serviceId);
  if (!service || closedReason(db, date, now)) return [];

  let pros = db.professionals;
  if (professionalId) pros = pros.filter((p) => p.id === professionalId);
  if (!pros.length) return [];

  const open = toMin(s.openTime);
  const close = toMin(s.closeTime);
  const lunch = s.lunchStart && s.lunchEnd ? [toMin(s.lunchStart), toMin(s.lunchEnd)] : null;
  // minutos que faltam, a partir de agora (no fuso do salão), para o início de cada horário
  const here = nowParts(now);
  const offset = daysBetween(here.date, date) * 1440 - here.minutes;

  const out = [];
  for (let t = open; t + service.duration <= close; t += s.slotMinutes) {
    if (offset + t < s.minNoticeHours * 60) continue; // já passou ou está dentro da antecedência mínima
    if (lunch && t < lunch[1] && t + service.duration > lunch[0]) continue;
    const pro = pros.find((p) => isFree(db, p.id, date, t, service.duration));
    if (pro) out.push({ time: toHM(t), professionalId: pro.id, free: true });
    else if (all) out.push({ time: toHM(t), professionalId: 0, free: false });
  }
  return out;
}

module.exports = { TZ, nowParts, toMin, toHM, isValidDate, todayStr, dateStr, timeStr, addDays, daysBetween, weekdayOf, closedReason, getSlots };
