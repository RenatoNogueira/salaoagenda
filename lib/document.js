// Validação e formatação de CPF e CNPJ (dígitos verificadores).
const digits = (s) => String(s || '').replace(/\D/g, '');

function validCPF(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(d[i]) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

function validCNPJ(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (let t = 12; t < 14; t++) {
    const weights = t === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[t])) return false;
  }
  return true;
}

/** Retorna { ok, kind: 'CPF'|'CNPJ', digits } */
function check(value) {
  const d = digits(value);
  if (d.length === 11) return { ok: validCPF(d), kind: 'CPF', digits: d };
  if (d.length === 14) return { ok: validCNPJ(d), kind: 'CNPJ', digits: d };
  return { ok: false, kind: null, digits: d };
}

function format(value) {
  const d = digits(value);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return String(value || '');
}

module.exports = { check, format, digits };
