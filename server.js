const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./lib/db');
const Theme = require('./public/js/theme.js');
const payments = require('./lib/payments');
const clientsLib = require('./lib/clients');
const documentLib = require('./lib/document');
const mailer = require('./lib/mailer');
const av = require('./lib/availability');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // atrás do proxy da Vercel: req.protocol/req.ip corretos
app.disable('x-powered-by');

// Logos enviadas (modo local) são servidas em uma "caixa de areia": um SVG enviado não consegue rodar scripts
app.use('/uploads', (req, res, next) => {
  res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plainPage = (title, text) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;line-height:1.5"><h1 style="font-size:22px">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
// sem armazenamento configurado (ex.: Vercel sem o Blob conectado): explica o que fazer em vez de quebrar
app.use((req, res, next) => (db.configError ? res.status(503).type('html').send(plainPage('Configuração pendente', db.configError)) : next()));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(db.middleware); // depois dos parsers de corpo: carrega/grava os dados de cada pedido

// Arquivos enviados ficam em memória e são gravados por db.storeLogo (disco local ou banco de dados)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpe?g|webp|svg)$/i.test(file.originalname)),
});

// Express 4 não captura erros de funções async sozinho
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------

const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (d) => d.split('-').reverse().join('/');
// (98) 99908-0312 / (98) 3333-4444; devolve o texto original se não parecer um telefone BR
const fmtPhone = (s) => {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(s || '');
};

// Resume os dias de atendimento: [1..6] -> "Segunda a sábado"; [1,3,5] -> "Segunda, quarta e sexta"
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function daysLabel(openDays) {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => openDays.includes(d)); // semana começando na segunda
  if (!order.length) return 'Consulte-nos';
  if (order.length === 7) return 'Todos os dias';
  const idx = (d) => (d + 6) % 7; // posição na semana (segunda = 0)
  const runs = [];
  order.forEach((d) => {
    const last = runs[runs.length - 1];
    if (last && idx(d) === idx(last[last.length - 1]) + 1) last.push(d);
    else runs.push([d]);
  });
  // sequências de 3+ dias viram "X a Y"; o resto é listado dia a dia
  const parts = runs.flatMap((r) => (r.length >= 3 ? [`${DAY_NAMES[r[0]]} a ${DAY_NAMES[r[r.length - 1]]}`] : r.map((d) => DAY_NAMES[d])));
  const text = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' e ' + parts[parts.length - 1] : parts[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// muda a cada build do CSS, para o celular não ficar com estilo antigo em cache
const cssVersion = () => {
  try {
    const pub = path.join(__dirname, 'public');
    const files = [path.join(pub, 'css', 'app.css'), ...fs.readdirSync(path.join(pub, 'js')).map((f) => path.join(pub, 'js', f))];
    return Math.floor(Math.max(...files.map((f) => fs.statSync(f).mtimeMs)));
  } catch (e) {
    return 0;
  }
};

const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
};

app.use((req, res, next) => {
  const d = db.get();
  res.locals.cssVersion = cssVersion();
  // cliente que já se cadastrou neste aparelho (cookie com token aleatório)
  const token = readCookie(req, 'cliente');
  res.locals.customer = token ? d.customers.find((c) => c.token === token) || null : null;
  res.locals.settings = d.settings;
  res.locals.theme = Theme.build(d.settings);
  res.locals.brl = brl;
  res.locals.dateBR = dateBR;
  res.locals.fmtPhone = fmtPhone;
  res.locals.daysLabel = daysLabel;
  res.locals.payMethods = payments.METHODS;
  const phoneDigits = d.settings.phone.replace(/\D/g, '');
  res.locals.waNumber = phoneDigits.length >= 10 ? (phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits) : '';
  res.locals.DAYS = DAYS;
  res.locals.path = req.path;
  next();
});

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 32);

function verifyPassword(pw) {
  const saved = db.get().admin;
  if (saved) return safeEqual(hashPassword(pw, saved.salt), Buffer.from(saved.hash, 'hex'));
  return safeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
}

const clean = (s, max = 80) => String(s || '').trim().slice(0, max);

// ----- sessão do painel: cookie assinado (sem estado no servidor, funciona em serverless) -----
// O valor é "validade.assinatura". A assinatura usa SESSION_SECRET + o hash da senha atual,
// então trocar/redefinir a senha encerra todas as sessões abertas.
const ADMIN_COOKIE = 'adm';
const ADMIN_TTL = 8 * 60 * 60 * 1000;
const FALLBACK_SECRET = crypto.randomBytes(24).toString('hex'); // só vale no modo local sem SESSION_SECRET
const signSession = (exp) => {
  const key = (process.env.SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN || FALLBACK_SECRET) + ':' + ((db.get().admin || {}).hash || '');
  return crypto.createHmac('sha256', key).update(String(exp)).digest('hex');
};
function loginAdmin(req, res) {
  const exp = Date.now() + ADMIN_TTL;
  res.cookie(ADMIN_COOKIE, `${exp}.${signSession(exp)}`, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: ADMIN_TTL, path: '/' });
}
const logoutAdmin = (res) => res.clearCookie(ADMIN_COOKIE, { path: '/' });
function isAdmin(req) {
  const [exp, sig] = readCookie(req, ADMIN_COOKIE).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = signSession(exp);
  return sig.length === expected.length && safeEqual(Buffer.from(sig), Buffer.from(expected));
}
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.redirect('/admin/login'));

// Permite "Adicionar à tela inicial" no celular, com o nome e a logo do salão
app.get('/manifest.webmanifest', (req, res) => {
  const s = db.get().settings;
  const types = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  res.type('application/manifest+json').json({
    name: s.name,
    short_name: s.name.slice(0, 12),
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1220',
    theme_color: s.color,
    icons: [{ src: s.logo, sizes: 'any', type: types[path.extname(s.logo).toLowerCase()] || 'image/png', purpose: 'any' }],
  });
});

// ---------- público ----------
app.get('/', (req, res) => {
  const d = db.get();
  res.render('index', { services: d.services, professionals: d.professionals, title: d.settings.name, waLift: true });
});

app.get('/agendar', (req, res) => {
  const d = db.get();
  res.render('agendar', {
    title: 'Agendar horário',
    services: d.services,
    professionals: d.professionals,
    today: av.todayStr(),
    maxDate: av.addDays(av.todayStr(), d.settings.maxDaysAhead),
    openDays: d.settings.openDays,
    blockedDates: d.blocks.map((b) => b.date),
    maxDays: d.settings.maxDaysAhead,
    waLift: true,
    preset: { service: Number(req.query.servico) || 0 },
  });
});

app.get('/api/horarios', (req, res) => {
  const d = db.get();
  const date = String(req.query.data || '');
  const slots = av.getSlots(d, {
    date,
    serviceId: Number(req.query.servico),
    professionalId: Number(req.query.profissional) || 0,
  });
  res.json({ slots, reason: slots.length ? null : av.closedReason(d, date) });
});

app.post('/api/agendar', (req, res) => {
  const d = db.get();
  const b = req.body;
  const serviceId = Number(b.serviceId);
  const professionalId = Number(b.professionalId) || 0;
  const name = clean(b.name);
  const phone = clean(b.phone, 20);
  const date = String(b.date || '');
  const time = String(b.time || '');

  if (name.length < 2 || phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: 'Informe seu nome e um telefone com DDD.' });
  }
  const service = d.services.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Serviço inválido.' });

  const slot = av.getSlots(d, { date, serviceId, professionalId }).find((s) => s.time === time);
  if (!slot) return res.status(409).json({ error: 'Esse horário acabou de ser ocupado. Escolha outro.' });

  const appt = {
    id: db.nextId('appointment'),
    token: crypto.randomBytes(8).toString('hex'),
    serviceId,
    professionalId: slot.professionalId,
    date,
    time,
    start: av.toMin(time),
    duration: service.duration,
    price: service.price,
    clientName: name,
    clientPhone: phone,
    notes: clean(b.notes, 200),
    status: 'pendente',
    createdAt: new Date().toISOString(),
  };
  d.appointments.push(appt);
  db.save();
  res.json({ url: '/confirmacao/' + appt.token });
});

// Cadastro/entrada da cliente por nome + telefone (sem senha). O telefone identifica a cliente e o
// primeiro nome precisa conferir; o aparelho fica "lembrado" por um cookie e o agendamento já vem preenchido.
const firstName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().split(/\s+/)[0] || '';

app.post('/api/cadastro', (req, res) => {
  const d = db.get();
  const name = clean(req.body.name);
  const phone = clean(req.body.phone, 20);
  const key = phone.replace(/\D/g, '');
  if (name.length < 2 || key.length < 10) {
    return res.status(400).json({ error: 'Informe seu nome e um telefone com DDD.' });
  }
  let c = d.customers.find((x) => x.phone.replace(/\D/g, '') === key);
  const returning = !!c;
  if (c) {
    if (firstName(c.name) !== firstName(name)) {
      return res.status(409).json({ error: 'Este telefone já está cadastrado com outro nome. Confira o nome digitado.' });
    }
    // só troca o nome se o digitado for mais completo (ex.: "Maria" -> "Maria Souza")
    if (name.split(/\s+/).length > c.name.split(/\s+/).length) c.name = name;
  } else {
    c = { id: db.nextId('customer'), token: crypto.randomBytes(16).toString('hex'), name, phone, createdAt: new Date().toISOString() };
    d.customers.push(c);
  }
  db.save();
  res.cookie('cliente', c.token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
  res.json({ ok: true, returning, name: c.name.split(' ')[0] });
});

app.post('/api/cadastro/sair', (req, res) => {
  res.clearCookie('cliente');
  res.json({ ok: true });
});

app.get('/confirmacao/:token', (req, res) => {
  const d = db.get();
  const appt = d.appointments.find((a) => a.token === req.params.token);
  if (!appt) return res.status(404).render('erro', { title: 'Não encontrado', msg: 'Agendamento não encontrado.' });
  res.render('confirmacao', {
    title: 'Agendamento recebido',
    appt,
    pay: payments.info(appt, priceOf(d, appt), d.settings.depositPercent),
    service: d.services.find((s) => s.id === appt.serviceId),
    professional: d.professionals.find((p) => p.id === appt.professionalId),
  });
});

app.post('/confirmacao/:token/cancelar', (req, res) => {
  const appt = db.get().appointments.find((a) => a.token === req.params.token);
  if (appt && appt.status !== 'concluido') {
    appt.status = 'cancelado';
    db.save();
  }
  res.redirect('/confirmacao/' + req.params.token);
});

// ---------- admin ----------
// Primeiro acesso: enquanto não existir dono cadastrado, tudo em /admin leva ao cadastro do salão.
const needsSetup = () => !db.get().owner;

async function replaceLogo(s, file, remove) {
  if (file) {
    const old = s.logo;
    s.logo = await db.storeLogo(file.buffer, file.originalname);
    await db.removeLogo(old);
  } else if (remove) {
    await db.removeLogo(s.logo);
    s.logo = '/img/logo-default.svg';
  }
}

// logos guardadas no banco (modo remoto); no modo local elas saem de /uploads
app.get('/media/:file', wrap(async (req, res) => {
  const file = req.params.file;
  const asset = /^[0-9a-f]{24}\.(png|jpe?g|webp|svg)$/.test(file) ? await db.readMedia(file) : null;
  if (!asset) return res.status(404).end();
  res.set({
    'Content-Type': asset.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(asset.data);
}));

app.get('/admin/cadastro', (req, res) => {
  if (!needsSetup()) return res.redirect(isAdmin(req) ? '/admin' : '/admin/login');
  const s = db.get().settings;
  res.render('admin/cadastro', { title: 'Primeiro acesso', error: null, form: { name: s.name === 'Meu Salão' ? '' : s.name, document: '', email: '' } });
});

app.post('/admin/cadastro', upload.single('logo'), db.restore, wrap(async (req, res) => {
  const d = db.get();
  if (!needsSetup()) return res.redirect('/admin/login');
  const b = req.body;
  const name = clean(b.name);
  const doc = documentLib.check(b.document);
  const email = clean(b.email, 120).toLowerCase();
  const fail = (error) => {
    res.status(400).render('admin/cadastro', { title: 'Primeiro acesso', error, form: { name, document: String(b.document || ''), email } });
  };
  if (name.length < 2) return fail('Informe o nome do salão.');
  if (!doc.ok) return fail(`${doc.kind || 'CPF ou CNPJ'} inválido. Confira os números digitados.`);
  if (!emailOk(email)) return fail('Informe um e-mail válido: ele será usado para recuperar a senha.');
  if (String(b.password || '').length < 6) return fail('A senha precisa ter pelo menos 6 caracteres.');
  if (b.password !== b.password2) return fail('As senhas não conferem.');

  d.settings.name = name;
  await replaceLogo(d.settings, req.file, false);
  d.owner = { document: doc.digits, kind: doc.kind, email, createdAt: new Date().toISOString() };
  const salt = crypto.randomBytes(16).toString('hex');
  d.admin = { salt, hash: hashPassword(String(b.password), salt).toString('hex') };
  db.save();
  loginAdmin(req, res);
  res.redirect('/admin');
}));

app.get('/admin/login', (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  if (isAdmin(req)) return res.redirect('/admin');
  res.render('admin/login', { title: 'Entrar', error: null, notice: req.query.redefinida ? 'Senha alterada! Entre com a nova senha.' : null });
});

// ----- recuperação de senha por e-mail -----
const emailOk = (s) => s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const resetAttempts = new Map(); // ip -> horários dos últimos pedidos (limite: 5 por hora)

app.get('/admin/recuperar', (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  res.render('admin/recuperar', { title: 'Recuperar senha', sent: false, error: null });
});

app.post('/admin/recuperar', wrap(async (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  const now = Date.now();
  const recent = (resetAttempts.get(req.ip) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= 5) {
    return res.status(429).render('admin/recuperar', { title: 'Recuperar senha', sent: false, error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }
  resetAttempts.set(req.ip, [...recent, now]);

  const d = db.get();
  const email = clean(req.body.email, 120).toLowerCase();
  // A resposta é sempre a mesma, exista o e-mail ou não (não revela qual e-mail é o do dono)
  if (d.owner && d.owner.email && d.owner.email === email && (!d.reset || now - d.reset.sentAt > 60 * 1000)) {
    const token = crypto.randomBytes(32).toString('hex');
    d.reset = { hash: hashToken(token), expires: now + 30 * 60 * 1000, sentAt: now };
    db.save();
    await db.flush(); // grava já e libera a trava de escrita antes do envio, que é lento
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const link = `${base}/admin/redefinir/${token}`;
    const name = d.settings.name;
    // O envio é aguardado: em serverless (Vercel) a função é encerrada logo após a resposta
    try {
      await mailer.send({
        to: d.owner.email,
        subject: `Redefinir senha do painel – ${name}`,
        text: `Olá!\n\nRecebemos um pedido para redefinir a senha do painel do ${name}.\nAbra o link abaixo (vale por 30 minutos):\n\n${link}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">${name.replace(/[<>&]/g, '')}</h2><p>Recebemos um pedido para <strong>redefinir a senha do painel</strong>.</p><p><a href="${link}" style="display:inline-block;background:${d.settings.color};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold">Criar nova senha</a></p><p style="color:#64748b;font-size:13px">O link vale por 30 minutos. Se não foi você, ignore este e-mail: sua senha continua a mesma.</p></div>`,
      });
    } catch (err) {
      console.error('Falha ao enviar e-mail de recuperação:', err.message);
    }
  } else {
    await new Promise((r) => setTimeout(r, 600)); // tempo parecido, para não revelar se o e-mail existe
  }
  res.render('admin/recuperar', { title: 'Recuperar senha', sent: true, error: null });
}));

const validReset = (token) => {
  const r = db.get().reset;
  return Boolean(r && r.expires > Date.now() && safeEqual(Buffer.from(hashToken(String(token))), Buffer.from(r.hash)));
};

app.get('/admin/redefinir/:token', (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  res.render('admin/redefinir', { title: 'Nova senha', valid: validReset(req.params.token), error: null });
});

app.post('/admin/redefinir/:token', (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  if (!validReset(req.params.token)) return res.status(400).render('admin/redefinir', { title: 'Nova senha', valid: false, error: null });
  const { password, password2 } = req.body;
  const fail = (error) => res.status(400).render('admin/redefinir', { title: 'Nova senha', valid: true, error });
  if (String(password || '').length < 6) return fail('A senha precisa ter pelo menos 6 caracteres.');
  if (password !== password2) return fail('As senhas não conferem.');
  const d = db.get();
  const salt = crypto.randomBytes(16).toString('hex');
  d.admin = { salt, hash: hashPassword(String(password), salt).toString('hex') };
  d.reset = null; // o link só vale uma vez
  db.save();
  res.redirect('/admin/login?redefinida=1');
});

app.post('/admin/login', (req, res) => {
  if (needsSetup()) return res.redirect('/admin/cadastro');
  if (verifyPassword(String(req.body.password || ''))) {
    loginAdmin(req, res);
    return res.redirect('/admin');
  }
  res.status(401).render('admin/login', { title: 'Entrar', error: 'Senha incorreta.', notice: null });
});

app.post('/admin/logout', (req, res) => {
  logoutAdmin(res);
  res.redirect('/admin/login');
});

app.use('/admin', (req, res, next) => (needsSetup() ? res.redirect('/admin/cadastro') : next()));
app.use('/admin', requireAdmin);

const priceOf = (d, a) => (a.price != null ? a.price : (d.services.find((s) => s.id === a.serviceId) || {}).price || 0);
const withRefs = (d, a) => ({
  ...a,
  service: d.services.find((s) => s.id === a.serviceId),
  professional: d.professionals.find((p) => p.id === a.professionalId),
  pay: payments.info(a, priceOf(d, a), d.settings.depositPercent),
});
const byWhen = (a, b) => a.date.localeCompare(b.date) || a.start - b.start;

app.get('/admin', (req, res) => {
  const d = db.get();
  const today = av.todayStr();
  const view = req.query.view === 'confirmar' ? 'confirmar' : 'dia';
  const date = av.isValidDate(String(req.query.data || '')) ? req.query.data : today;

  const upcomingPending = d.appointments.filter((a) => a.status === 'pendente' && a.date >= today).sort(byWhen);
  const base = { title: 'Agenda', section: 'agenda', view, today, date, pending: upcomingPending.length };

  if (view === 'confirmar') {
    const groups = [];
    upcomingPending.forEach((a) => {
      let g = groups[groups.length - 1];
      if (!g || g.date !== a.date) {
        g = { date: a.date, weekday: DAYS[new Date(a.date + 'T00:00:00').getDay()], items: [] };
        groups.push(g);
      }
      g.items.push(withRefs(d, a));
    });
    return res.render('admin/agenda', { ...base, groups, list: [], strip: [] });
  }

  // faixa com 7 dias em volta da data escolhida, marcando onde há horários e pendências
  const strip = [-3, -2, -1, 0, 1, 2, 3].map((i) => {
    const day = av.addDays(date, i);
    const items = d.appointments.filter((a) => a.date === day && a.status !== 'cancelado');
    return {
      date: day,
      weekday: DAYS[new Date(day + 'T00:00:00').getDay()].slice(0, 3),
      dd: day.slice(8),
      count: items.length,
      pending: items.some((a) => a.status === 'pendente'),
    };
  });
  const list = d.appointments.filter((a) => a.date === date).sort(byWhen).map((a) => withRefs(d, a));
  res.render('admin/agenda', {
    ...base,
    list,
    groups: [],
    strip,
    prev: av.addDays(date, -1),
    next: av.addDays(date, 1),
    weekday: DAYS[new Date(date + 'T00:00:00').getDay()],
  });
});

const STATUSES = ['pendente', 'confirmado', 'concluido', 'cancelado'];

app.post('/admin/agendamentos/:id/status', (req, res) => {
  const d = db.get();
  const appt = d.appointments.find((a) => a.id === Number(req.params.id));
  if (appt && STATUSES.includes(req.body.status)) {
    appt.status = req.body.status;
    db.save();
  }
  // Pedido feito pelo JavaScript da agenda: devolve só o cartão atualizado
  if (req.get('X-Requested-With') === 'fetch') {
    if (!appt) return res.status(404).end();
    return res.render('admin/_card', { a: withRefs(d, appt), today: av.todayStr(), showDate: req.body.showDate === '1' });
  }
  res.redirect(req.get('referer') || '/admin');
});

// pagamento: sinal (percentual configurado), à vista/restante ou estorno do último lançamento
app.post('/admin/agendamentos/:id/pagamento', (req, res) => {
  const d = db.get();
  const appt = d.appointments.find((a) => a.id === Number(req.params.id));
  if (!appt) return res.status(404).end();
  const pay = payments.info(appt, priceOf(d, appt), d.settings.depositPercent);
  if (['sinal', 'total', 'restante', 'estornar'].includes(req.body.acao) && payments.apply(appt, pay, req.body.acao, req.body.forma)) {
    db.save();
  }
  if (req.get('X-Requested-With') === 'fetch') {
    return res.render('admin/_card', { a: withRefs(d, appt), today: av.todayStr(), showDate: req.body.showDate === '1' });
  }
  res.redirect(req.get('referer') || '/admin');
});

// confirma de uma vez todos os pendentes de um dia (data=YYYY-MM-DD) ou de toda a agenda futura (data=todos)
app.post('/admin/agendamentos/confirmar-todos', (req, res) => {
  const d = db.get();
  const today = av.todayStr();
  const scope = String(req.body.data || '');
  let n = 0;
  d.appointments.forEach((a) => {
    if (a.status === 'pendente' && a.date >= today && (scope === 'todos' || a.date === scope)) {
      a.status = 'confirmado';
      n += 1;
    }
  });
  if (n) db.save();
  res.redirect(req.get('referer') || '/admin');
});

// serviços
app.get('/admin/servicos', (req, res) => {
  res.render('admin/servicos', { title: 'Serviços', section: 'servicos', services: db.get().services });
});

app.post('/admin/servicos', (req, res) => {
  const d = db.get();
  const data = {
    name: clean(req.body.name),
    duration: Math.max(5, Math.min(480, Number(req.body.duration) || 30)),
    price: Math.max(0, Number(String(req.body.price).replace(',', '.')) || 0),
  };
  if (!data.name) return res.redirect('/admin/servicos');
  const existing = d.services.find((s) => s.id === Number(req.body.id));
  if (existing) Object.assign(existing, data);
  else d.services.push({ id: db.nextId('service'), ...data });
  db.save();
  res.redirect('/admin/servicos');
});

app.post('/admin/servicos/:id/excluir', (req, res) => {
  const d = db.get();
  d.services = d.services.filter((s) => s.id !== Number(req.params.id));
  db.save();
  res.redirect('/admin/servicos');
});

// profissionais
app.get('/admin/profissionais', (req, res) => {
  res.render('admin/profissionais', { title: 'Profissionais', section: 'profissionais', professionals: db.get().professionals });
});

app.post('/admin/profissionais', (req, res) => {
  const d = db.get();
  const data = { name: clean(req.body.name) };
  if (!data.name) return res.redirect('/admin/profissionais');
  const existing = d.professionals.find((p) => p.id === Number(req.body.id));
  if (existing) Object.assign(existing, data);
  else d.professionals.push({ id: db.nextId('professional'), ...data });
  db.save();
  res.redirect('/admin/profissionais');
});

app.post('/admin/profissionais/:id/excluir', (req, res) => {
  const d = db.get();
  d.professionals = d.professionals.filter((p) => p.id !== Number(req.params.id));
  db.save();
  res.redirect('/admin/profissionais');
});

// personalização (nome, logo, cor, horários)
app.get('/admin/configuracoes', (req, res) => {
  const owner = db.get().owner;
  res.render('admin/configuracoes', {
    title: 'Personalização',
    section: 'config',
    saved: req.query.ok === '1',
    senha: req.query.senha || '',
    docError: req.query.doc === 'erro',
    emailError: req.query.email === 'erro',
    ownerDocument: owner ? documentLib.format(owner.document) : '',
    ownerEmail: owner && owner.email ? owner.email : '',
    mailReady: mailer.configured(),
  });
});

app.post('/admin/configuracoes', upload.single('logo'), db.restore, wrap(async (req, res) => {
  const s = db.get().settings;
  const b = req.body;
  s.name = clean(b.name) || s.name;
  s.tagline = clean(b.tagline, 120);
  s.phone = clean(b.phone, 30);
  s.address = clean(b.address, 120);
  if (/^#[0-9a-f]{6}$/i.test(b.color || '')) s.color = b.color;
  if (/^#[0-9a-f]{6}$/i.test(b.accent || '')) s.accent = b.accent;
  if (['dark', 'light', 'auto'].includes(b.defaultTheme)) s.defaultTheme = b.defaultTheme;
  if (Object.keys(Theme.RADIUS).includes(b.radius)) s.radius = b.radius;
  if (/^\d{2}:\d{2}$/.test(b.openTime) && /^\d{2}:\d{2}$/.test(b.closeTime) && b.openTime < b.closeTime) {
    s.openTime = b.openTime;
    s.closeTime = b.closeTime;
  }
  s.slotMinutes = [15, 20, 30, 60].includes(Number(b.slotMinutes)) ? Number(b.slotMinutes) : s.slotMinutes;
  s.openDays = [].concat(b.openDays || []).map(Number).filter((n) => n >= 0 && n <= 6);
  if (/^\d{2}:\d{2}$/.test(b.lunchStart) && /^\d{2}:\d{2}$/.test(b.lunchEnd) && b.lunchStart < b.lunchEnd) {
    s.lunchStart = b.lunchStart;
    s.lunchEnd = b.lunchEnd;
  } else {
    s.lunchStart = s.lunchEnd = '';
  }
  s.activeDays = Math.max(7, Math.min(365, Math.round(Number(b.activeDays)) || s.activeDays));
  s.depositPercent = Math.max(1, Math.min(100, Math.round(Number(b.depositPercent)) || s.depositPercent));
  s.pixKey = clean(b.pixKey, 120);
  s.payNote = clean(b.payNote, 200);
  s.maxDaysAhead = Math.max(1, Math.min(365, Number(b.maxDaysAhead) || s.maxDaysAhead));
  s.minNoticeHours = Math.max(0, Math.min(72, Number(b.minNoticeHours) || 0));

  await replaceLogo(s, req.file, b.removeLogo);

  // CPF/CNPJ do responsável: só troca se for válido
  let docError = false;
  if (String(b.document || '').trim()) {
    const doc = documentLib.check(b.document);
    if (doc.ok) db.get().owner = { ...db.get().owner, document: doc.digits, kind: doc.kind };
    else docError = true;
  }
  // e-mail do responsável (recuperação de senha): só troca se for válido
  let emailError = false;
  const email = clean(b.email, 120).toLowerCase();
  if (email) {
    if (emailOk(email)) db.get().owner = { ...db.get().owner, email };
    else emailError = true;
  }
  db.save();
  res.redirect('/admin/configuracoes?ok=1' + (docError ? '&doc=erro' : '') + (emailError ? '&email=erro' : ''));
}));

// bloqueios (feriados, folgas, viagens)
app.get('/admin/bloqueios', (req, res) => {
  const blocks = [...db.get().blocks].sort((a, b) => a.date.localeCompare(b.date));
  res.render('admin/bloqueios', { title: 'Bloqueios', section: 'bloqueios', blocks, today: av.todayStr() });
});

app.post('/admin/bloqueios', (req, res) => {
  const d = db.get();
  const from = String(req.body.from || '');
  const to = String(req.body.to || from);
  if (av.isValidDate(from) && av.isValidDate(to) && from <= to) {
    const reason = clean(req.body.reason, 80);
    for (let day = from, n = 0; day <= to && n < 120; day = av.addDays(day, 1), n++) {
      if (!d.blocks.some((b) => b.date === day)) d.blocks.push({ id: db.nextId('block'), date: day, reason });
    }
    db.save();
  }
  res.redirect('/admin/bloqueios');
});

app.post('/admin/bloqueios/:id/excluir', (req, res) => {
  const d = db.get();
  d.blocks = d.blocks.filter((b) => b.id !== Number(req.params.id));
  db.save();
  res.redirect('/admin/bloqueios');
});

// relatórios
app.get('/admin/relatorios', (req, res) => {
  const d = db.get();
  const month = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : av.todayStr().slice(0, 7);
  const list = d.appointments.filter((a) => a.date.startsWith(month));
  const done = list.filter((a) => a.status === 'concluido');
  const value = (a) => (a.price != null ? a.price : (d.services.find((s) => s.id === a.serviceId) || {}).price || 0);
  const group = (arr, key, label) => {
    const map = new Map();
    arr.forEach((a) => {
      const k = key(a);
      const row = map.get(k) || { label: label(a), count: 0, total: 0 };
      row.count += 1;
      row.total += value(a);
      map.set(k, row);
    });
    return [...map.values()].sort((x, y) => y.total - x.total || y.count - x.count);
  };
  const svcName = (a) => (d.services.find((s) => s.id === a.serviceId) || { name: 'Serviço removido' }).name;
  const proName = (a) => (d.professionals.find((p) => p.id === a.professionalId) || { name: 'Removido' }).name;
  const count = (st) => list.filter((a) => a.status === st).length;
  // recebido = pagamentos lançados no mês (independe do status do agendamento)
  const received = d.appointments
    .flatMap((a) => a.payments || [])
    .filter((p) => p.at.startsWith(month))
    .reduce((t, p) => t + p.amount, 0);
  res.render('admin/relatorios', {
    title: 'Relatórios',
    section: 'relatorios',
    month,
    received,
    revenue: done.reduce((t, a) => t + value(a), 0),
    expected: list.filter((a) => ['pendente', 'confirmado'].includes(a.status)).reduce((t, a) => t + value(a), 0),
    counts: { total: list.length, pendente: count('pendente'), confirmado: count('confirmado'), concluido: count('concluido'), cancelado: count('cancelado') },
    byService: group(done, (a) => a.serviceId, svcName),
    byPro: group(done, (a) => a.professionalId, proName),
  });
});

// clientes (ativas, em risco, inativas, novas)
app.get('/admin/clientes', (req, res) => {
  const d = db.get();
  const q = clean(req.query.q, 40).toLowerCase();
  const status = ['ativa', 'risco', 'inativa', 'nova'].includes(req.query.status) ? req.query.status : 'todas';
  const sort = ['nome', 'recente', 'antiga', 'gasto', 'visitas'].includes(req.query.ordem) ? req.query.ordem : 'nome';

  const all = clientsLib.build(d, av.todayStr());
  const counts = { todas: all.length, ativa: 0, risco: 0, inativa: 0, nova: 0 };
  all.forEach((c) => { counts[c.status] += 1; });

  let clients = all.filter((c) => status === 'todas' || c.status === status);
  if (q) clients = clients.filter((c) => c.name.toLowerCase().includes(q) || c.key.includes(q.replace(/\D/g, '') || '\0'));
  const cmp = {
    nome: (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
    recente: (a, b) => (b.last || '').localeCompare(a.last || ''),
    antiga: (a, b) => (a.last || '9999').localeCompare(b.last || '9999'),
    gasto: (a, b) => b.spent - a.spent,
    visitas: (a, b) => b.visits - a.visits,
  }[sort];
  clients.sort(cmp);

  res.render('admin/clientes', {
    title: 'Clientes',
    section: 'clientes',
    clients,
    counts,
    status,
    sort,
    q,
    activeDays: d.settings.activeDays,
    origin: `${req.protocol}://${req.get('host')}`,
  });
});

// entradas (pagamentos recebidos) por período
const periodFrom = (req) => {
  const today = av.todayStr();
  const ok = (s) => av.isValidDate(String(s || ''));
  let from = ok(req.query.de) ? req.query.de : today.slice(0, 8) + '01';
  let to = ok(req.query.ate) ? req.query.ate : today;
  if (from > to) [from, to] = [to, from];
  return { from, to, today };
};

function incomeEntries(d, from, to) {
  const rows = [];
  d.appointments.forEach((a) => {
    const w = withRefs(d, a);
    (a.payments || []).forEach((p) => {
      const day = av.dateStr(new Date(p.at));
      if (day < from || day > to) return;
      rows.push({
        day,
        at: p.at,
        amount: p.amount,
        method: p.method,
        kind: p.kind,
        client: a.clientName,
        phone: a.clientPhone,
        service: w.service ? w.service.name : 'Serviço removido',
        apptDate: a.date,
        apptId: a.id,
      });
    });
  });
  return rows.sort((x, y) => y.at.localeCompare(x.at));
}

app.get('/admin/entradas', (req, res) => {
  const d = db.get();
  const { from, to, today } = periodFrom(req);
  const entries = incomeEntries(d, from, to);
  const total = entries.reduce((t, e) => t + e.amount, 0);

  const sumBy = (key) => {
    const m = new Map();
    entries.forEach((e) => m.set(e[key], (m.get(e[key]) || 0) + e.amount));
    return m;
  };
  const byMethod = Object.entries(payments.METHODS).map(([k, label]) => ({
    key: k,
    label,
    total: sumBy('method').get(k) || 0,
    count: entries.filter((e) => e.method === k).length,
  }));
  const dayMap = sumBy('day');
  const byDay = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, t]) => ({ day, total: t }));

  // a receber: saldo de agendamentos ativos (não cancelados) com data no período
  const open = d.appointments
    .filter((a) => a.date >= from && a.date <= to && a.status !== 'cancelado')
    .reduce((t, a) => t + withRefs(d, a).pay.remaining, 0);

  const addDays = (n) => av.addDays(today, n);
  const monthStart = today.slice(0, 8) + '01';
  const prevEnd = av.addDays(monthStart, -1);
  res.render('admin/entradas', {
    title: 'Entradas',
    section: 'entradas',
    from,
    to,
    entries,
    total,
    count: entries.length,
    byMethod,
    byDay,
    open,
    presets: [
      ['Hoje', today, today],
      ['7 dias', addDays(-6), today],
      ['Este mês', monthStart, today],
      ['Mês passado', prevEnd.slice(0, 8) + '01', prevEnd],
    ],
  });
});

app.get('/admin/entradas.csv', (req, res) => {
  const { from, to } = periodFrom(req);
  const entries = incomeEntries(db.get(), from, to).sort((a, b) => a.at.localeCompare(b.at));
  const money = (v) => v.toFixed(2).replace('.', ',');
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [['Data', 'Hora', 'Cliente', 'Telefone', 'Serviço', 'Data do atendimento', 'Forma', 'Tipo', 'Valor (R$)']];
  const kinds = { sinal: 'Sinal', total: 'À vista', restante: 'Restante' };
  entries.forEach((e) => {
    const t = new Date(e.at);
    lines.push([
      dateBR(e.day),
      t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      e.client,
      e.phone,
      e.service,
      dateBR(e.apptDate),
      payments.METHODS[e.method] || e.method,
      kinds[e.kind] || e.kind,
      money(e.amount),
    ]);
  });
  // BOM + ponto e vírgula: abre direto no Excel em português
  const csv = '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="entradas_${from}_a_${to}.csv"` });
  res.send(csv);
});

// trocar senha
app.post('/admin/senha', (req, res) => {
  const { current, next } = req.body;
  if (!verifyPassword(String(current || '')) || String(next || '').length < 6) {
    return res.redirect('/admin/configuracoes?senha=erro');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.get().admin = { salt, hash: hashPassword(String(next), salt).toString('hex') };
  db.save();
  loginAdmin(req, res); // a troca de senha encerra as sessões antigas; renova só a desta pessoa
  res.redirect('/admin/configuracoes?senha=ok');
});

app.use((err, req, res, next) => {
  console.error(err);
  db.rollback(); // pedido com erro não grava nada pela metade
  if (res.headersSent) return next(err);
  // Página de erro do sistema; se nem ela puder ser montada (ex.: banco fora do ar), responde texto simples
  const show = (status, title, msg) =>
    res.status(status).render('erro', { title, msg }, (renderErr, html) => {
      if (renderErr) return res.type('html').send(plainPage(title, msg));
      res.send(html);
    });
  if (err && err.code === 'LIMIT_FILE_SIZE') return show(413, 'Arquivo grande', 'A imagem pode ter no máximo 2 MB.');
  if (err && err.dbConnection) {
    // o motivo real (sem segredos) ajuda o responsável a corrigir sem precisar abrir os logs
    const detail = `${err.name || 'Erro'}: ${String(err.message || '').replace(/vercel_blob_rw_[\w-]+/g, '[token]')}`.slice(0, 220).replace(/[.\s]+$/, '');
    const hint = err.hint ? ` Configuração: ${err.hint}.` : '';
    return show(503, 'Armazenamento indisponível', `Não foi possível acessar os dados do salão. Se você é o responsável, confira se o Blob está conectado ao projeto na Vercel (variável BLOB_READ_WRITE_TOKEN). Detalhe técnico: ${detail}.${hint}`);
  }
  if (err && err.code === 'DB_CONFLICT') return show(409, 'Tente novamente', 'Outra alteração aconteceu ao mesmo tempo. Volte e repita a ação.');
  show(500, 'Erro', 'Algo deu errado. Tente novamente.');
});

// Na Vercel o app é importado por api/index.js (sem listen); localmente, `node server.js` sobe o servidor.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Salão rodando em http://localhost:${PORT}`);
    console.log(`Painel: http://localhost:${PORT}/admin`);
    console.log(db.isRemote ? 'Dados: arquivo JSON no Vercel Blob' : 'Dados: arquivo data/db.json (local)');
  });
}

module.exports = app;
