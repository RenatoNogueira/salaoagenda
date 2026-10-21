// Calcula a paleta (variáveis CSS) a partir das cores escolhidas no painel.
// Usado no servidor (para renderizar o <head>) e no navegador (pré-visualização ao vivo).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Theme = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var RADIUS = { reto: '8px', moderno: '16px', suave: '28px' };
  var DARK_SURFACE = [30, 41, 59];

  function rgb(hex, fallback) {
    var h = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : fallback;
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    return a.map(function (c, i) { return Math.round(c + (b[i] - c) * t); });
  }
  var str = function (c) { return c.join(' '); };

  function build(s) {
    var base = rgb(s.color, '#be185d');
    var acc = rgb(s.accent, '#f97316');
    var white = [255, 255, 255];
    var black = [0, 0, 0];

    var light = {
      brand: base,
      'brand-dark': mix(base, black, 0.2),
      'brand-soft': mix(base, white, 0.9),
      'brand-2': mix(base, acc, 0.45),
      accent: acc,
    };
    // No escuro a cor principal é clareada para manter contraste sobre o fundo
    var lifted = mix(base, white, 0.15);
    var dark = {
      brand: lifted,
      'brand-dark': base,
      'brand-soft': mix(base, DARK_SURFACE, 0.8),
      'brand-2': mix(lifted, acc, 0.45),
      accent: mix(acc, white, 0.1),
    };
    var css = function (o) {
      return Object.keys(o).map(function (k) { return '--' + k + ':' + str(o[k]); }).join(';');
    };
    var radius = RADIUS[s.radius] || RADIUS.moderno;
    return { light: light, dark: dark, lightCss: css(light) + ';--radius:' + radius, darkCss: css(dark), radius: radius };
  }

  return { build: build, RADIUS: RADIUS, str: str };
});
