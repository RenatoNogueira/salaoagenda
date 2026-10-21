// Acesso ao Vercel Blob (armazenamento de arquivos da Vercel).
// O documento do salão é UM arquivo JSON. Cada leitura devolve o ETag dele, e a gravação só vale se o ETag
// ainda for o mesmo ("ifMatch"): assim duas gravações simultâneas nunca se sobrescrevem.
//
// Um "store" do Blob é Private ou Public, e o acesso precisa ser o mesmo do store. O padrão é Private
// (recomendado: só o servidor lê). Se o store for Public, o sistema percebe (erro 403) e passa a usar o modo
// público sozinho; nesse caso o arquivo de dados fica em um caminho difícil de adivinhar. Para forçar um modo,
// defina BLOB_ACCESS=private ou BLOB_ACCESS=public.
//
// Para testes (ou outro armazenamento) é possível apontar BLOB_ADAPTER_MODULE para um módulo com a mesma interface.
const crypto = require('crypto');
const blob = require('@vercel/blob');

const forced = process.env.BLOB_ACCESS === 'public' || process.env.BLOB_ACCESS === 'private' ? process.env.BLOB_ACCESS : null;
let access = forced || 'private';

// No modo público a URL do arquivo é aberta a quem a souber; por isso o nome inclui um trecho derivado do token (segredo).
const docPath = () =>
  access === 'public'
    ? `salao-${crypto.createHash('sha256').update('doc:' + (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || '')).digest('hex').slice(0, 32)}/db.json`
    : 'salao/db.json';

const toBuffer = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

/** Executa a operação no modo atual; se o store for do outro tipo (403), tenta o outro modo e passa a usá-lo. */
async function withAccess(fn) {
  try {
    return await fn(access);
  } catch (err) {
    if (forced || err.code === 'PRECONDITION' || !/403|forbidden|access/i.test(String(err.message))) throw err;
    const other = access === 'private' ? 'public' : 'private';
    const result = await fn(other);
    access = other;
    console.log(`Vercel Blob: este store é ${other === 'public' ? 'Public' : 'Private'}; usando acesso ${other}.`);
    return result;
  }
}

module.exports = {
  /** { text, etag } ou null se o documento ainda não existe. Sempre lê a versão mais nova (sem cache). */
  readDoc() {
    return withAccess(async (acc) => {
      const r = await blob.get(pathFor(acc), { access: acc, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return { text: (await toBuffer(r.stream)).toString('utf8'), etag: r.blob.etag };
    });
  },

  /** Cria o documento; falha se já existir (alguém criou antes). */
  createDoc(text) {
    return withAccess((acc) =>
      blob.put(pathFor(acc), text, { access: acc, contentType: 'application/json', allowOverwrite: false, addRandomSuffix: false })
    );
  },

  /** Substitui o documento só se o ETag ainda for o lido; senão lança erro com code 'PRECONDITION'. */
  writeDoc(text, { ifMatch }) {
    return withAccess(async (acc) => {
      try {
        await blob.put(pathFor(acc), text, { access: acc, contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, ifMatch });
      } catch (err) {
        if (err instanceof blob.BlobPreconditionFailedError) err.code = 'PRECONDITION';
        throw err;
      }
    });
  },

  putFile(name, buffer, mime) {
    return withAccess((acc) => blob.put(`logos/${name}`, buffer, { access: acc, contentType: mime, allowOverwrite: false, addRandomSuffix: false }));
  },

  /** { mime, data } ou null */
  getFile(name) {
    return withAccess(async (acc) => {
      const r = await blob.get(`logos/${name}`, { access: acc });
      if (!r || r.statusCode !== 200) return null;
      return { mime: r.blob.contentType, data: await toBuffer(r.stream) };
    });
  },

  delFile(name) {
    return blob.del(`logos/${name}`);
  },
};

// caminho do documento para um modo específico (usado ao testar o outro modo durante a detecção)
function pathFor(acc) {
  const saved = access;
  access = acc;
  const p = docPath();
  access = saved;
  return p;
}
