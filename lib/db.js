// Camada de dados do salão. Interface única (get / save / nextId) com dois modos, ambos em arquivo JSON:
//  - LOCAL (padrão): arquivo data/db.json; logos em public/uploads.
//  - NUVEM (Vercel): o mesmo JSON guardado no Vercel Blob, quando existir BLOB_READ_WRITE_TOKEN. Na Vercel o
//    disco é temporário, por isso o arquivo vai para o armazenamento deles. Cada pedido recebe o documento
//    já carregado (via AsyncLocalStorage) e a gravação acontece antes de a resposta ser enviada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const isRemote = Boolean(process.env.BLOB_ADAPTER_MODULE || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

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

const store = isRemote ? require('./db-blob') : null;
const als = new AsyncLocalStorage();

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

// Na Vercel o disco é somente leitura: sem o Blob conectado não dá para guardar nada.
// Em vez de derrubar a função (erro 500 sem explicação), o servidor mostra o que falta configurar.
const configError =
  !isRemote && process.env.VERCEL
    ? 'Falta conectar o armazenamento de dados: na Vercel abra Storage → Create → Blob, conecte ao projeto (isso cria a variável BLOB_READ_WRITE_TOKEN) e faça um Redeploy.'
    : null;

if (!isRemote && !configError) loadLocal();

// ---------- API ----------
function ctxOrThrow() {
  const ctx = als.getStore();
  if (!ctx) throw new Error('db: acesso aos dados fora de um pedido HTTP');
  return ctx;
}

// normaliza o documento do pedido uma única vez (preenche campos novos de versões antigas)
function normalizeOnce(ctx) {
  if (!ctx.normalized) {
    ctx.data = normalize(ctx.data);
    ctx.normalized = true;
  }
  return ctx.data;
}

const get = () => (isRemote ? normalizeOnce(ctxOrThrow()) : localData);

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

/** Grava já (antes de uma operação lenta, como enviar e-mail). */
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

const MAX_TRIES = 8;

/**
 * Middleware: carrega o documento do pedido e grava antes de enviar a resposta (vai depois dos parsers de corpo).
 * Se outra gravação acontecer no meio (conflito de ETag), o pedido inteiro é repetido com os dados novos.
 */
function middleware(req, res, next) {
  if (!isRemote) return next();
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  store
    .begin(defaults(), write)
    .then((ctx) => {
      req.dbCtx = ctx;
      const originalEnd = res.end;
      res.end = function (...args) {
        res.end = originalEnd;
        ctx.commit().then(
          () => originalEnd.apply(res, args),
          (err) => {
            const canRetry = err.code === 'DB_CONFLICT' && (req._dbTries || 0) < MAX_TRIES && !req.is('multipart/form-data');
            if (canRetry) {
              // descarta a resposta já montada e refaz o pedido do começo, agora com os dados atualizados
              req._dbTries = (req._dbTries || 0) + 1;
              res.getHeaderNames().forEach((h) => res.removeHeader(h));
              res.statusCode = 200;
              return setTimeout(() => req.app.handle(req, res), 30 + Math.random() * 120);
            }
            console.error('Falha ao gravar os dados:', err.message);
            res.removeHeader('Location');
            res.statusCode = err.code === 'DB_CONFLICT' ? 409 : 500;
            originalEnd.call(res, err.code === 'DB_CONFLICT' ? 'Outra alteração aconteceu ao mesmo tempo. Tente novamente.' : 'Erro ao salvar os dados. Tente novamente.');
          }
        );
        return res;
      };
      als.run(ctx, next);
    })
    .catch((err) => {
      err.dbConnection = true; // permite mostrar uma mensagem clara em vez de um erro genérico
      next(err);
    });
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
    const file = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    await store.saveAsset(file, MIME[ext], buffer);
    return `/media/${file}`;
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
    await store.deleteAsset(path.basename(url)).catch(() => {});
  } else if (!isRemote && url.startsWith('/uploads/')) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
  }
}

/** Lê um arquivo enviado (modo nuvem). Retorna { mime, data } ou null. */
async function readMedia(file) {
  if (!isRemote) return null;
  return store.getAsset(file);
}

module.exports = { get, save, nextId, flush, rollback, middleware, restore, storeLogo, removeLogo, readMedia, isRemote, configError, defaults, normalize };