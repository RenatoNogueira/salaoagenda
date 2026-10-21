// Acesso ao Vercel Blob (armazenamento de arquivos da Vercel).
// O documento do salão é UM arquivo JSON. Cada leitura devolve o ETag dele, e a gravação só vale se o ETag
// ainda for o mesmo ("ifMatch"): assim duas gravações simultâneas nunca se sobrescrevem.
//
// Autenticação: por padrão a SDK escolhe sozinha (OIDC da Vercel + BLOB_STORE_ID, ou BLOB_READ_WRITE_TOKEN).
// Se a escolha padrão for recusada ("Access denied") e existir um BLOB_READ_WRITE_TOKEN de formato válido,
// o sistema tenta de novo usando esse token explicitamente e passa a usá-lo.
//
// Tipo do store: Private ou Public. A pergunta "o arquivo existe?" é feita pela API (head), que também informa
// o tipo na URL; só depois o conteúdo é baixado. Em store Public o arquivo de dados fica em um caminho difícil de
// adivinhar (derivado do token). Para forçar um modo, defina BLOB_ACCESS=private ou BLOB_ACCESS=public.
//
// Para testes (ou outro armazenamento) é possível apontar BLOB_ADAPTER_MODULE para um módulo com a mesma interface.
const crypto = require('crypto');
const blob = require('@vercel/blob');

// Erro comum ao colar o token na Vercel: aspas ou espaços/quebra de linha nas pontas (ex.: "vercel_blob_rw_..."). Limpa antes de usar.
for (const key of ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID']) {
  if (process.env[key]) process.env[key] = process.env[key].trim().replace(/^["']+|["']+$/g, '').trim();
}

const TOKEN_RE = /^vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+$/;
const forced = process.env.BLOB_ACCESS === 'public' || process.env.BLOB_ACCESS === 'private' ? process.env.BLOB_ACCESS : null;
let access = forced; // null = ainda não descoberto
let docKnown = false; // já lemos o documento com sucesso nesta instância
let useToken = false; // autenticar sempre pelo BLOB_READ_WRITE_TOKEN (depois de a escolha padrão ser recusada)

/** O token OIDC que a Vercel entrega à função (cabeçalho da requisição ou variável de ambiente), sem assinatura exposta. */
function describeOidc() {
  let token;
  let source;
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.() ?? {};
    token = ctx.headers?.['x-vercel-oidc-token'];
    source = 'cabeçalho da requisição';
  } catch (err) {
    // sem contexto de requisição (ex.: rodando fora da Vercel)
  }
  if (!token && process.env.VERCEL_OIDC_TOKEN) {
    token = process.env.VERCEL_OIDC_TOKEN;
    source = 'variável VERCEL_OIDC_TOKEN';
  }
  if (!token) return 'OIDC: nenhum token recebido';
  try {
    // mostra só alguns campos não secretos do JWT: ambiente e validade
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const minutes = claims.exp ? Math.round((claims.exp * 1000 - Date.now()) / 60000) : null;
    const validity = minutes === null ? '' : minutes < 0 ? `, EXPIRADO há ${-minutes} min` : `, expira em ${minutes} min`;
    return `OIDC: token recebido via ${source}${claims.environment ? `, ambiente ${claims.environment}` : ''}${validity}`;
  } catch (err) {
    return `OIDC: token recebido via ${source} (conteúdo ilegível)`;
  }
}

/** Descrição segura da autenticação configurada (sem revelar segredos), para diagnóstico. */
function describeToken() {
  const store = process.env.BLOB_STORE_ID ? 'BLOB_STORE_ID presente' : 'BLOB_STORE_ID ausente';
  const t = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (!t) return `${store}, BLOB_READ_WRITE_TOKEN ausente, ${describeOidc()}`;
  if (TOKEN_RE.test(t)) return `${store}, token com formato válido (${t.length} caracteres)`;
  // nunca repete o conteúdo de um token fora do padrão: pode ser outro segredo colado por engano
  return `${store}, token com formato inesperado (${t.length} caracteres; ${t.startsWith('vercel_blob_rw_') ? 'tem caracteres fora do padrão' : 'não começa com vercel_blob_rw_'})`;
}

const hasValidToken = () => TOKEN_RE.test(process.env.BLOB_READ_WRITE_TOKEN || '');
const isAuthError = (err) => /access denied|valid token|unauthori[sz]ed|forbidden|\b40[13]\b/i.test(String(err && err.message));

/** Roda uma chamada da SDK; se a autenticação padrão for recusada, repete com o token explícito. */
async function withAuth(fn) {
  if (useToken) return fn({ token: process.env.BLOB_READ_WRITE_TOKEN });
  try {
    return await fn({});
  } catch (err) {
    if (!hasValidToken() || !isAuthError(err)) throw err;
    const result = await fn({ token: process.env.BLOB_READ_WRITE_TOKEN });
    useToken = true;
    console.log('Vercel Blob: autenticação padrão recusada; usando BLOB_READ_WRITE_TOKEN.');
    return result;
  }
}

const docPath = (acc) =>
  acc === 'public'
    ? `salao-${crypto.createHash('sha256').update('doc:' + (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || '')).digest('hex').slice(0, 32)}/db.json`
    : 'salao/db.json';

const accessOfUrl = (url) => (/^https:\/\/[^./]+\.public\.blob\./.test(url) ? 'public' : 'private');
const isNotFound = (err) => err instanceof blob.BlobNotFoundError || /not.?found|\b404\b/i.test(String(err && err.message));
const toBuffer = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

/** Pergunta à API se o documento existe (e em qual tipo de store). Devolve os metadados ou null. */
async function locateDoc() {
  for (const acc of access ? [access] : ['private', 'public']) {
    try {
      const meta = await withAuth((auth) => blob.head(docPath(acc), auth));
      if (!forced) access = accessOfUrl(meta.url);
      return meta;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

async function downloadDoc() {
  const acc = access || 'private';
  const r = await withAuth((auth) => blob.get(docPath(acc), { access: acc, useCache: false, ...auth }));
  if (!r || r.statusCode !== 200) return null;
  return { text: (await toBuffer(r.stream)).toString('utf8'), etag: r.blob.etag };
}

module.exports = {
  describeToken,

  /** { text, etag } ou null se o documento ainda não existe. Sempre lê a versão mais nova (sem cache). */
  async readDoc() {
    if (docKnown) {
      try {
        const doc = await downloadDoc();
        if (doc) return doc;
      } catch (err) {
        // cai na descoberta abaixo, que diz o motivo real se o problema continuar
      }
      docKnown = false;
    }
    if (!(await locateDoc())) return null;
    const doc = await downloadDoc();
    if (doc) docKnown = true;
    return doc;
  },

  /** Cria o documento; lança erro "already exists" se alguém criou antes. */
  async createDoc(text) {
    const tried = [];
    for (const acc of access ? [access] : ['private', 'public']) {
      try {
        await withAuth((auth) =>
          blob.put(docPath(acc), text, { access: acc, contentType: 'application/json', allowOverwrite: false, addRandomSuffix: false, ...auth })
        );
        access = acc;
        return;
      } catch (err) {
        if (/already exists/i.test(String(err.message))) throw err;
        tried.push(`${acc}: ${err.message}`);
      }
    }
    throw new Error(`Não foi possível criar o arquivo de dados (${tried.join(' | ')})`);
  },

  /** Substitui o documento só se o ETag ainda for o lido; senão lança erro com code 'PRECONDITION'. */
  async writeDoc(text, { ifMatch }) {
    const acc = access || 'private';
    try {
      await withAuth((auth) =>
        blob.put(docPath(acc), text, { access: acc, contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, ifMatch, ...auth })
      );
    } catch (err) {
      if (err instanceof blob.BlobPreconditionFailedError) err.code = 'PRECONDITION';
      throw err;
    }
  },

  async putFile(name, buffer, mime) {
    const acc = access || 'private';
    await withAuth((auth) => blob.put(`logos/${name}`, buffer, { access: acc, contentType: mime, allowOverwrite: false, addRandomSuffix: false, ...auth }));
  },

  /** { mime, data } ou null */
  async getFile(name) {
    const acc = access || 'private';
    try {
      const r = await withAuth((auth) => blob.get(`logos/${name}`, { access: acc, ...auth }));
      if (!r || r.statusCode !== 200) return null;
      return { mime: r.blob.contentType, data: await toBuffer(r.stream) };
    } catch (err) {
      if (/403|forbidden/i.test(String(err.message))) return null; // arquivo inexistente em alguns stores responde 403
      throw err;
    }
  },

  delFile(name) {
    return withAuth((auth) => blob.del(`logos/${name}`, auth));
  },
};
