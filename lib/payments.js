// Controle de pagamentos de um agendamento: sinal (percentual do valor) e/ou valor total.
// Cada pagamento fica em a.payments = [{ amount, method, kind, at }].
const round2 = (n) => Math.round(n * 100) / 100;

const METHODS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };

/** state: nenhum | parcial (pagou menos que o sinal) | sinal (sinal pago, falta o resto) | pago */
function info(appt, price, depositPercent) {
  const total = round2(price || 0);
  const paid = round2((appt.payments || []).reduce((t, p) => t + p.amount, 0));
  const deposit = round2((total * depositPercent) / 100);
  const remaining = Math.max(0, round2(total - paid));
  let state = 'nenhum';
  if (paid > 0) state = remaining <= 0 ? 'pago' : paid >= deposit ? 'sinal' : 'parcial';
  return { total, paid, deposit, remaining, depositLeft: Math.max(0, round2(deposit - paid)), state };
}

/** Registra/estorna um pagamento. Retorna false se a ação não se aplica. */
function apply(appt, pay, action, method) {
  appt.payments = appt.payments || [];
  if (action === 'estornar') {
    return appt.payments.pop() !== undefined;
  }
  const amount = action === 'sinal' ? pay.depositLeft : action === 'total' || action === 'restante' ? pay.remaining : 0;
  if (!(amount > 0)) return false;
  appt.payments.push({
    amount,
    method: METHODS[method] ? method : 'pix',
    kind: action,
    at: new Date().toISOString(),
  });
  return true;
}

module.exports = { info, apply, METHODS, round2 };
