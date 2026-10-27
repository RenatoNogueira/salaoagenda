// Armazenamento do documento do salão em um arquivo JSON no Vercel Blob (veja blob-adapter.js).
// Concorrência otimista: cada pedido lê o documento + ETag; se na hora de gravar alguém já tiver gravado,
// a gravação é recusada (code 'DB_CONFLICT') e o servidor repete o pedido inteiro com os dados novos.
const adapter = process.env.BLOB_ADAPTER_MODULE ? require(require('path').resolve(process.env.BLOB_ADAPTER_MODULE)) : require('./blob-adapter');

function conflict() {
  const err = new Error('Outra alteração foi gravada ao mesmo tempo.');
  err.code = 'DB_CONFLICT';
  return err;
}

async function load(seedDoc) {
  let cur = await adapter.readDoc();
  if (!cur) {
    // primeiro uso: cria o documento inicial. Nunca sobrescreve: se outro pedido criou ao mesmo tempo, só lemos de novo.
    let createError;
    await adapter.createDoc(JSON.stringify(seedDoc)).catch((err) => { createError = err; });
    cur = await adapter.readDoc();
    // se ainda não existe, a criação falhou de verdade (ex.: token inválido): mostra a causa real
    if (!cur) throw createError || new Error('Não foi possível criar o arquivo de dados no Blob.');
  }
  return { data: JSON.parse(cur.text), etag: cur.etag };
}

/** Abre o contexto de um pedido: o documento já carregado e as funções para gravar/descartar. */
async function begin(seedDoc, write) {
  const { data, etag } = await load(seedDoc);
  const ctx = {
    data,
    write,
    dirty: false,
    done: !write,
    async commit() {
      if (ctx.done) return;
      ctx.done = true;
      if (!ctx.dirty) return;
      try {
        await adapter.writeDoc(JSON.stringify(ctx.data), { ifMatch: etag });
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

module.exports = {
  selfTest: () => (adapter.selfTest ? adapter.selfTest() : Promise.resolve([])),
  describe: () => (adapter.describeToken ? adapter.describeToken() : ''),
  begin,
  saveAsset: (name, mime, buffer) => adapter.putFile(name, buffer, mime),
  getAsset: (name) => adapter.getFile(name),
  deleteAsset: (name) => adapter.delFile(name),
};
