// Agrupa os agendamentos por cliente (pelo telefone) e classifica cada uma:
//   ativa   — última visita concluída há até `activeDays` dias
//   risco   — entre `activeDays` e 2x `activeDays` dias sem voltar
//   inativa — mais de 2x `activeDays` dias sem voltar
//   nova    — ainda sem nenhuma visita concluída
const dayDiff = (from, to) => Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000);

function build(db, today) {
  const activeDays = db.settings.activeDays;
  const map = new Map();

  // clientes que se cadastraram sozinhas aparecem mesmo sem nenhum agendamento
  (db.customers || []).forEach((cu) => {
    const key = cu.phone.replace(/\D/g, '');
    if (!key) return;
    map.set(key, {
      key, name: cu.name, phone: cu.phone, visits: 0, spent: 0, last: '', next: '', booked: 0, cancelled: 0,
      firstSeen: cu.createdAt.slice(0, 10), registered: true, birthday: cu.birthday || '',
    });
  });

  db.appointments.forEach((a) => {
    const key = a.clientPhone.replace(/\D/g, '');
    if (!key) return;
    const price = a.price != null ? a.price : (db.services.find((s) => s.id === a.serviceId) || {}).price || 0;
    const c = map.get(key) || { key, name: a.clientName, phone: a.clientPhone, visits: 0, spent: 0, last: '', next: '', booked: 0, cancelled: 0, firstSeen: a.date };
    // usa o nome/telefone do agendamento mais recente
    if (a.date >= (c.latestDate || '')) {
      c.latestDate = a.date;
      c.name = a.clientName;
      c.phone = a.clientPhone;
    }
    if (a.date < c.firstSeen) c.firstSeen = a.date;
    // prefere o nome informado no cadastro, se houver
    if (c.registered) c.name = (db.customers.find((x) => x.phone.replace(/\D/g, '') === key) || {}).name || c.name;
    if (a.status === 'concluido') {
      c.visits += 1;
      c.spent += price;
      if (a.date > c.last) c.last = a.date;
    }
    if (a.status === 'cancelado') c.cancelled += 1;
    else c.booked += 1;
    if (['pendente', 'confirmado'].includes(a.status) && a.date >= today && (!c.next || a.date < c.next)) c.next = a.date;
    map.set(key, c);
  });

  return [...map.values()].map((c) => {
    const daysAway = c.last ? dayDiff(c.last, today) : null;
    let status = 'nova';
    if (c.last) status = daysAway <= activeDays ? 'ativa' : daysAway <= activeDays * 2 ? 'risco' : 'inativa';
    return { ...c, daysAway, status, ticket: c.visits ? c.spent / c.visits : 0 };
  });
}

module.exports = { build, dayDiff };
