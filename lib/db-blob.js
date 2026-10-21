// Armazenamento dos salões em arquivos JSON no Vercel Blob (um arquivo por salão; veja blob-adapter.js).
// Concorrência otimista: cada pedido lê o documento do salão + ETag; se na hora de gravar alguém já tiver gravado,
// a gravação é recusada (code 'DB_CONFLICT') e o servidor repete o pedido inteiro com os dados novos.
const adapter = process.env.BLOB_ADAPTER_MODULE ? require(require('path').resolve(process.env.BLOB_ADAPTER_MODULE)) : require('./blob-adapter');

function conflict() {
  const err = new Error('Outra alteração foi gravada ao mesmo tempo.');
  err.code = 'DB_CONFLICT';
  return err;
}

/**
 * Migração automática do salão do formato antigo (um salão só, em salao/db.json): se MIGRATE_LEGACY_TO=<slug> estiver
 * definida, o primeiro acesso a /<slug> copia o salão antigo (e a logo) para tenants/<slug>/. O arquivo antigo não é apagado.
 */
async function migrateLegacy(slug) {
  if (process.env.MIGRATE_LEGACY_TO !== slug || !adapter.readLegacyDoc) return null;
  const legacy = await adapter.readLegacyDoc();
  if (!legacy) return null;
  const doc = JSON.parse(legacy.text);
  const logo = (doc.settings && doc.settings.logo) || '';
  if (logo.startsWith('/media/') && adapter.readLegacyLogo) {
    const name = logo.split('/').pop();
    const asset = await adapter.readLegacyLogo(name);
    if (asset) await adapter.putFile(slug, name, asset.data, asset.mime).catch(() => {});
  }
  try {
    await adapter.createDoc(slug, JSON.stringify(doc));
  } catch (err) {
    if (!/already exists/i.test(String(err.message))) throw err; // outro pedido migrou ao mesmo tempo
  }
  console.log(`Salão antigo migrado para /${slug}.`);
  return adapter.readDoc(slug);
}

/** Abre o contexto de um pedido: o documento do salão já carregado e as funções para gravar/descartar. */
async function begin(slug, write) {
  let cur = await adapter.readDoc(slug);
  if (!cur) cur = await migrateLegacy(slug);
  if (!cur) {
    const err = new Error('Salão não encontrado.');
    err.code = 'TENANT_NOT_FOUND';
    throw err;
  }
  const { etag } = cur;
  const ctx = {
    slug,
    data: JSON.parse(cur.text),
    write,
    dirty: false,
    done: !write,
    async commit() {
      if (ctx.done) return;
      ctx.done = true;
      if (!ctx.dirty) return;
      try {
        await adapter.writeDoc(slug, JSON.stringify(ctx.data), { ifMatch: etag });
      } catch (err) {
        if (err.code === 'PRECONDITION') throw conflict();
        throw err;
      }
    },
    async abort() {
      ctx.done = true;
    },
  };
  return ctx;
}

/** Cria um salão novo. Falha com code 'TENANT_EXISTS' se o endereço (slug) já estiver em uso. */
async function create(slug, doc) {
  try {
    await adapter.createDoc(slug, JSON.stringify(doc));
  } catch (err) {
    if (/already exists/i.test(String(err.message))) {
      const e = new Error('Endereço já em uso.');
      e.code = 'TENANT_EXISTS';
      throw e;
    }
    throw err;
  }
}

module.exports = {
  describe: () => (adapter.describeToken ? adapter.describeToken() : ''),
  begin,
  create,
  readLegacy: () => adapter.readLegacyDoc(),
  saveAsset: (slug, name, mime, buffer) => adapter.putFile(slug, name, buffer, mime),
  getAsset: (slug, name) => adapter.getFile(slug, name),
  deleteAsset: (slug, name) => adapter.delFile(slug, name),
};
