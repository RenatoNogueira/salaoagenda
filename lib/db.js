// Camada de dados do salão. Interface única (get / save / nextId) com dois modos:
//  - LOCAL (padrão): arquivo JSON em data/db.json; logos em public/uploads.
//  - REMOTO: PostgreSQL, quando existir DATABASE_URL (ou POSTGRES_URL). É o modo da Vercel, onde o disco
//    é temporário. Cada pedido recebe o documento já carregado (via AsyncLocalStorage), e a gravação
//    acontece antes de a resposta ser enviada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const REMOTE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const isRemote = Boolean(REMOTE_URL);

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

const defaults = () => ({
  seq: { service: 5, professional: 2, appointment: 0, block: 0, customer: 0 },
  settings: {
    name: 'Meu Salão',
    tagline: 'Beleza e cuidado para você, com hora marcada',
    logo: '/img/logo-default.svg',
    color: '#be185d',
    accent: '#f97316', // cor de destaque (degradês e detalhes)
    defaultTheme: 'dark', // dark | light | auto
    radius: 'moderno', // reto | moderno | suave
    phone: '(11) 99999-0000',
    address: 'Rua Exemplo, 123 - Centro',
    openTime: '09:00',
    closeTime: '19:00',
    slotMinutes: 30,
    openDays: [2, 3, 4, 5, 6], // 0=domingo ... 6=sábado
    lunchStart: '12:00', // vazio = sem pausa
    lunchEnd: '13:00',
    activeDays: 60, // cliente é "ativa" se voltou nesse prazo (em risco até o dobro)
    depositPercent: 50, // sinal para garantir o horário
    pixKey: '', // chave Pix mostrada à cliente
    payNote: '', // instruções extras de pagamento
    maxDaysAhead: 60,
    minNoticeHours: 2,
  },
  blocks: [], // { id, date: 'YYYY-MM-DD', reason }
  customers: [], // cadastro feito pela própria cliente: { id, token, name, phone, createdAt }
  admin: null, // { salt, hash } — senha definida no primeiro acesso (ou ao trocá-la no painel)
  reset: null, // recuperação de senha em andamento: { hash (sha256 do token), expires, sentAt }
  owner: null, // responsável pelo salão: { document (só dígitos), kind: 'CPF'|'CNPJ', email, createdAt }; null = falta o primeiro acesso
  services: [
    { id: 1, name: 'Corte', duration: 60, price: 90 },
    { id: 2, name: 'Escova', duration: 60, price: 70 },
    { id: 3, name: 'Coloração', duration: 120, price: 180 },
    { id: 4, name: 'Hidratação', duration: 60, price: 80 },
    { id: 5, name: 'Manicure', duration: 45, price: 40 },
  ],
  professionals: [
    { id: 1, name: 'Marina' },
    { id: 2, name: 'Juliana' },
  ],
  appointments: [],
});

// completa documentos antigos com campos novos
const normalize = (saved) => {
  const d = defaults();
  return { ...d, ...saved, settings: { ...d.settings, ...saved.settings }, seq: { ...d.seq, ...saved.seq } };
};

const pg = isRemote ? require('./db-pg') : null;
const als = new AsyncLocalStorage();
const seedDoc = () => defaults();

// ---------- modo local ----------
let localData;

function loadLocal() {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(FILE)) localData = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  else {
    localData = defaults();
    saveLocal();
  }
}

function saveLocal() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(localData, null, 2));
  fs.renameSync(tmp, FILE);
}

if (!isRemote) loadLocal();

// ---------- API ----------
function ctxOrThrow() {
  const ctx = als.getStore();
  if (!ctx) throw new Error('db: acesso aos dados fora de um pedido HTTP');
  return ctx;
}

const get = () => (isRemote ? normalizeOnce(ctxOrThrow()) : localData);

// normaliza o documento do pedido uma única vez (preenche campos novos de versões antigas)
function normalizeOnce(ctx) {
  if (!ctx.normalized) {
    ctx.data = normalize(ctx.data);
    ctx.normalized = true;
  }
  return ctx.data;
}

function save() {
  if (!isRemote) return saveLocal();
  const ctx = ctxOrThrow();
  if (!ctx.write) throw new Error('db: este pedido é somente leitura (use POST para alterar dados)');
  ctx.dirty = true;
}

function nextId(kind) {
  const d = get();
  d.seq[kind] += 1;
  return d.seq[kind];
}

/** Grava já (antes de uma operação lenta, como enviar e-mail) e libera a trava de escrita. */
async function flush() {
  if (!isRemote) return;
  const ctx = ctxOrThrow();
  if (ctx.commit) await ctx.commit();
}

/** Descarta as alterações do pedido atual (usado quando o pedido termina em erro). */
function rollback() {
  const ctx = als.getStore();
  if (ctx) ctx.dirty = false;
}

/** Middleware: carrega o documento do pedido e grava antes de enviar a resposta. Vai depois dos parsers de corpo. */
function middleware(req, res, next) {
  if (!isRemote) return next();
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  pg.begin(REMOTE_URL, seedDoc(), write)
    .then((ctx) => {
      req.dbCtx = ctx;
      const originalEnd = res.end;
      res.end = function (...args) {
        res.end = originalEnd;
        const finish = ctx.commit ? ctx.commit() : Promise.resolve();
        finish.then(
          () => originalEnd.apply(res, args),
          (err) => {
            console.error('Falha ao gravar os dados:', err);
            res.statusCode = 500;
            res.removeHeader('Location');
            originalEnd.call(res, 'Erro ao salvar os dados. Tente novamente.');
          }
        );
        return res;
      };
      res.once('close', () => ctx.abort && ctx.abort().catch(() => {})); // conexão caiu antes do fim
      als.run(ctx, next);
    })
    .catch(next);
}

/** Retoma o contexto do pedido (necessário depois de middlewares baseados em streams, como o multer). */
function restore(req, res, next) {
  if (isRemote && req.dbCtx) return als.run(req.dbCtx, next);
  next();
}

// ---------- logos / arquivos enviados ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** Guarda a logo enviada e devolve a URL pública dela. */
async function storeLogo(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!MIME[ext]) throw new Error('Formato de imagem não suportado');
  if (isRemote) {
    const id = crypto.randomBytes(12).toString('hex');
    await pg.saveAsset(REMOTE_URL, seedDoc(), id, MIME[ext], buffer);
    return `/media/${id}${ext}`;
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `logo-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `/uploads/${name}`;
}

/** Apaga uma logo enviada antes (as logos padrão do sistema são ignoradas). */
async function removeLogo(url) {
  if (!url) return;
  if (isRemote && url.startsWith('/media/')) {
    await pg.deleteAsset(REMOTE_URL, seedDoc(), path.basename(url, path.extname(url))).catch(() => {});
  } else if (!isRemote && url.startsWith('/uploads/')) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
  }
}

/** Lê um arquivo enviado (modo remoto). Retorna { mime, data } ou null. */
async function readMedia(id) {
  if (!isRemote) return null;
  return pg.getAsset(REMOTE_URL, seedDoc(), id);
}

module.exports = { get, save, nextId, flush, rollback, middleware, restore, storeLogo, removeLogo, readMedia, isRemote, defaults, normalize };
