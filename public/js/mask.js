// Máscara de telefone brasileiro: (11) 99999-9999 ou (11) 3333-4444.
// Use em qualquer campo com o atributo data-mask="phone".
(function () {
  function phone(value) {
    var d = value.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d;
    // Fixo (10 dígitos) usa 4-4; celular (11 dígitos) usa 5-4
    var cut = d.length > 10 ? 7 : 6;
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, cut) + (d.length > cut ? '-' + d.slice(cut) : '');
  }
  // CPF (000.000.000-00) até 11 dígitos; a partir daí vira CNPJ (00.000.000/0000-00)
  function cpfcnpj(value) {
    var d = value.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 11) {
      return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
    }
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  }
  document.querySelectorAll('[data-mask="cpfcnpj"]').forEach(function (el) {
    el.setAttribute('inputmode', 'numeric');
    el.setAttribute('maxlength', '18');
    el.setAttribute('placeholder', el.getAttribute('placeholder') || 'CPF ou CNPJ');
    el.value = cpfcnpj(el.value);
    el.addEventListener('input', function () { el.value = cpfcnpj(el.value); });
  });

  document.querySelectorAll('[data-mask="phone"]').forEach(function (el) {
    el.setAttribute('inputmode', 'tel');
    el.setAttribute('maxlength', '16');
    el.setAttribute('placeholder', el.getAttribute('placeholder') || '(11) 99999-9999');
    el.value = phone(el.value);
    el.addEventListener('input', function () { el.value = phone(el.value); });
  });
})();
