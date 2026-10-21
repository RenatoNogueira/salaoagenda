// Camada de dados do sistema MULTIEMPRESA: cada salão (empresa) tem o próprio documento JSON, identificado
// pelo endereço (slug) que vem na URL (/<slug>/...). Interface única (get / save / nextId) com dois modos:
//  - LOCAL (padrão): um arquivo por salão em data/<slug>/db.json; logos em data/<slug>/logos.
//  - NUVEM (Vercel): um arquivo JSON por salão no Vercel Blob, quando existir BLOB_READ_WRITE_TOKEN ou
//    BLOB_STORE_ID (na Vercel o disco é temporário). Cada pedido recebe o documento do salão já carregado
//    (via AsyncLocalStorage) e a gravação acontece antes de a resposta ser enviada.
// Salões são totalmente isolados: um pedido só enxerga o documento do salão da própria URL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const isRemote = Boolean(process.env.BLOB_ADAPTER_MODULE || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
const tenantDir = (slug) => path.join(DIR, slug);
const tenantFile = (slug) => path.join(tenantDir(slug), 'db.json');
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
const localCache = new Map(); // slug -> documento (objeto compartilhado entre pedidos)

/**
 * Migração automática do salão do formato antigo (data/db.json): se MIGRATE_LEGACY_TO=<slug> estiver definida, o
 * primeiro acesso a /<slug> copia o salão antigo (e a logo de public/uploads) para data/<slug>/. O arquivo antigo fica.
 */
function migrateLegacyLocal(slug) {
  const legacyFile = path.join(DIR, 'db.json');
  if (process.env.MIGRATE_LEGACY_TO !== slug || !fs.existsSync(legacyFile)) return;
  const doc = normalize(JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
  const logo = doc.settings.logo || '';
  if (logo.startsWith('/uploads/')) {
    const src = path.join(__dirname, '..', 'public', 'uploads', path.basename(logo));
    if (fs.existsSync(src)) {
      const name = `${crypto.randomBytes(12).toString('hex')}${path.extname(src).toLowerCase()}`;
      fs.mkdirSync(path.join(tenantDir(slug), 'logos'), { recursive: true });
      fs.copyFileSync(src, path.join(tenantDir(slug), 'logos', name));
      doc.settings.logo = `/media/${name}`;
    } else {
      doc.settings.logo = '/img/logo-default.svg';
    }
  }
  saveLocal(slug, doc);
  console.log(`Salão antigo (data/db.json) migrado para /${slug}.`);
}

function loadLocal(slug) {
  if (localCache.has(slug)) return localCache.get(slug);
  const file = tenantFile(slug);
  if (!fs.existsSync(file)) migrateLegacyLocal(slug);
  if (!fs.existsSync(file)) return null;
  const data = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  localCache.set(slug, data);
  return data;
}

function saveLocal(slug, data) {
  fs.mkdirSync(tenantDir(slug), { recursive: true });
  const tmp = tenantFile(slug) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, tenantFile(slug));
}

// Na Vercel o disco é somente leitura: sem o Blob conectado não dá para guardar nada.
// Em vez de derrubar a função (erro 500 sem explicação), o servidor mostra o que falta configurar.
const configError =
  !isRemote && process.env.VERCEL
    ? 'Falta conectar o armazenamento de dados: na Vercel abra Storage → Create → Blob, conecte ao projeto (isso cria as variáveis do Blob) e faça um Redeploy.'
    : null;

// ---------- API (sempre dentro de um pedido de um salão) ----------
function ctxOrThrow() {
  const ctx = als.getStore();
  if (!ctx) throw new Error('db: acesso aos dados fora de um pedido de salão');
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

const get = () => normalizeOnce(ctxOrThrow());
const currentSlug = () => ctxOrThrow().slug;

function save() {
  const ctx = ctxOrThrow();
  if (!isRemote) return saveLocal(ctx.slug, ctx.data);
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
 * Middleware montado em /:slug: carrega o documento DO SALÃO da URL e, no modo nuvem, grava antes de enviar a resposta
 * (vai depois dos parsers de corpo). Se outra gravação no mesmo salão acontecer no meio (conflito de ETag), o pedido
 * inteiro é repetido com os dados novos. Salão inexistente: erro com code 'TENANT_NOT_FOUND'.
 */
function middleware(req, res, next) {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return notFound(next);

  if (!isRemote) {
    const data = loadLocal(slug);
    if (!data) return notFound(next);
    // o documento do cache já está normalizado e é compartilhado entre pedidos (não pode ser copiado)
    req.dbCtx = { slug, data, write: true, dirty: false, normalized: true };
    return als.run(req.dbCtx, next);
  }

  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  store
    .begin(slug, write)
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
              req.url = req.originalUrl;
              req.baseUrl = '';
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
      if (err.code !== 'TENANT_NOT_FOUND') {
        err.dbConnection = true; // permite mostrar uma mensagem clara em vez de um erro genérico
        err.hint = store.describe(); // ex.: formato do token configurado (sem revelar o segredo)
      }
      next(err);
    });
}

function notFound(next) {
  const err = new Error('Salão não encontrado.');
  err.code = 'TENANT_NOT_FOUND';
  next(err);
}

/** Retoma o contexto do pedido (necessário depois de middlewares baseados em streams, como o multer). */
function restore(req, res, next) {
  if (req.dbCtx) return als.run(req.dbCtx, next);
  next();
}

/** Cria um salão novo (cadastro na plataforma). Falha com code 'TENANT_EXISTS' se o endereço já estiver em uso. */
async function createTenant(slug, doc) {
  if (!SLUG_RE.test(slug)) throw new Error('Endereço inválido.');
  if (isRemote) return store.create(slug, doc);
  if (fs.existsSync(tenantFile(slug))) {
    const err = new Error('Endereço já em uso.');
    err.code = 'TENANT_EXISTS';
    throw err;
  }
  saveLocal(slug, doc);
  localCache.set(slug, normalize(doc));
}

// ---------- logos / arquivos enviados ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** Nome aleatório para uma logo (valida a extensão). O arquivo é servido em /<slug>/media/<nome>. */
function logoFileName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!MIME[ext]) throw new Error('Formato de imagem não suportado');
  return `${crypto.randomBytes(12).toString('hex')}${ext}`;
}

async function saveLogoFile(slug, fileName, buffer) {
  if (isRemote) return store.saveAsset(slug, fileName, MIME[path.extname(fileName)], buffer);
  fs.mkdirSync(path.join(tenantDir(slug), 'logos'), { recursive: true });
  fs.writeFileSync(path.join(tenantDir(slug), 'logos', fileName), buffer);
}

/** Guarda a logo enviada pelo salão do pedido atual e devolve o caminho dela (/media/<nome>). */
async function storeLogo(buffer, originalName) {
  const name = logoFileName(originalName);
  await saveLogoFile(currentSlug(), name, buffer);
  return `/media/${name}`;
}

/** Apaga uma logo enviada antes (as logos padrão do sistema são ignoradas). */
async function removeLogo(url) {
  if (!url || !url.startsWith('/media/')) return;
  const slug = currentSlug();
  const name = path.basename(url);
  if (isRemote) await store.deleteAsset(slug, name).catch(() => {});
  else fs.rm(path.join(tenantDir(slug), 'logos', name), () => {});
}

/** Lê uma logo de um salão. Retorna { mime, data } ou null. */
async function readMedia(slug, file) {
  if (!SLUG_RE.test(slug) || !/^[0-9a-f]{24}\.(png|jpe?g|webp|svg)$/.test(file)) return null;
  if (isRemote) return store.getAsset(slug, file);
  const f = path.join(tenantDir(slug), 'logos', file);
  return fs.existsSync(f) ? { mime: MIME[path.extname(file)], data: fs.readFileSync(f) } : null;
}

module.exports = {
  get, save, nextId, flush, rollback, middleware, restore, currentSlug,
  createTenant, logoFileName, saveLogoFile, storeLogo, removeLogo, readMedia,
  isRemote, configError, defaults, normalize, SLUG_RE, DIR, tenantDir, tenantFile,
  readLegacyRemote: () => (store ? store.readLegacy() : null),
};