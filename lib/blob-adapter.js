// Acesso ao Vercel Blob (armazenamento de arquivos da Vercel). Tudo é privado: só o servidor lê e grava.
// O documento do salão é UM arquivo JSON (salao/db.json). Cada leitura devolve o ETag dele, e a gravação
// só vale se o ETag ainda for o mesmo ("ifMatch"): assim duas gravações simultâneas nunca se sobrescrevem.
//
// Para testes (ou outro armazenamento) é possível apontar BLOB_ADAPTER_MODULE para um módulo com a mesma interface.
const blob = require('@vercel/blob');

const DOC = 'salao/db.json';
const toBuffer = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

module.exports = {
  /** { text, etag } ou null se o documento ainda não existe. Sempre lê a versão mais nova (sem cache). */
  async readDoc() {
    const r = await blob.get(DOC, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { text: (await toBuffer(r.stream)).toString('utf8'), etag: r.blob.etag };
  },

  /** Cria o documento; falha se já existir (alguém criou antes). */
  async createDoc(text) {
    await blob.put(DOC, text, { access: 'private', contentType: 'application/json', allowOverwrite: false, addRandomSuffix: false });
  },

  /** Substitui o documento só se o ETag ainda for o lido; senão lança erro com code 'PRECONDITION'. */
  async writeDoc(text, { ifMatch }) {
    try {
      await blob.put(DOC, text, { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, ifMatch });
    } catch (err) {
      if (err instanceof blob.BlobPreconditionFailedError) err.code = 'PRECONDITION';
      throw err;
    }
  },

  async putFile(name, buffer, mime) {
    await blob.put(`logos/${name}`, buffer, { access: 'private', contentType: mime, allowOverwrite: false, addRandomSuffix: false });
  },

  /** { mime, data } ou null */
  async getFile(name) {
    const r = await blob.get(`logos/${name}`, { access: 'private' });
    if (!r || r.statusCode !== 200) return null;
    return { mime: r.blob.contentType, data: await toBuffer(r.stream) };
  },

  async delFile(name) {
    await blob.del(`logos/${name}`);
  },
};
