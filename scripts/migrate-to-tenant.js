// Leva um salão do formato antigo (um salão só por instalação) para o formato multiempresa.
//
//   npm run migrate:db -- <endereco-do-salao>                 copia data/db.json (e a logo de public/uploads)
//   npm run migrate:db -- <endereco-do-salao> --from-blob     copia o salão antigo que está no Vercel Blob (salao/db.json)
//   adicione --force para sobrescrever um salão que já existe nesse endereço
//
// O destino segue a configuração do ambiente: com BLOB_READ_WRITE_TOKEN/BLOB_STORE_ID grava no Blob, senão em data/<endereco>/.
// Exemplo (PowerShell, para enviar o salão do seu computador para a Vercel):
//   $env:BLOB_READ_WRITE_TOKEN="..."; npm run migrate:db -- meusalao
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const args = process.argv.slice(2);
const slug = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const fromBlob = args.includes('--from-blob');
const force = args.includes('--force');

const RESERVED = ['admin', 'api', 'criar', 'login', 'cadastro', 'media', 'uploads', 'css', 'js', 'img', 'tenants', 'salao'];
const adapter = db.isRemote ? (process.env.BLOB_ADAPTER_MODULE ? require(path.resolve(process.env.BLOB_ADAPTER_MODULE)) : require('../lib/blob-adapter')) : null;

(async () => {
  if (!slug || !db.SLUG_RE.test(slug) || RESERVED.includes(slug)) {
    throw new Error('Informe o endereço do salão (2 a 30 caracteres: letras minúsculas, números e hífen). Ex.: npm run migrate:db -- meusalao');
  }

  // 1) lê o salão de origem
  let source;
  if (fromBlob) {
    if (!db.isRemote) throw new Error('--from-blob precisa das variáveis do Blob (BLOB_READ_WRITE_TOKEN ou BLOB_STORE_ID).');
    const legacy = await db.readLegacyRemote();
    if (!legacy) throw new Error('Não encontrei o salão antigo no Blob (salao/db.json).');
    source = db.normalize(JSON.parse(legacy.text));
  } else {
    const file = path.join(db.DIR, 'db.json');
    if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);
    source = db.normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  // 2) a logo enviada passa a viver na pasta do salão
  const logo = source.settings.logo || '';
  let logoFile = null;
  let logoBuffer = null;
  if (fromBlob && logo.startsWith('/media/')) {
    const name = path.basename(logo);
    const asset = await adapter.readLegacyLogo(name);
    if (asset) { logoFile = name; logoBuffer = asset.data; }
  } else if (!fromBlob && logo.startsWith('/uploads/')) {
    const f = path.join(__dirname, '..', 'public', 'uploads', path.basename(logo));
    if (fs.existsSync(f)) { logoFile = db.logoFileName(f); logoBuffer = fs.readFileSync(f); }
  }
  source.settings.logo = logoFile ? `/media/${logoFile}` : logo.startsWith('/media/') || logo.startsWith('/uploads/') ? '/img/logo-default.svg' : logo;

  // 3) grava no destino
  try {
    await db.createTenant(slug, source);
  } catch (err) {
    if (err.code !== 'TENANT_EXISTS') throw err;
    if (!force) throw new Error(`Já existe um salão em "${slug}". Para sobrescrever, rode de novo com --force.`);
    if (db.isRemote) {
      const cur = await adapter.readDoc(slug);
      await adapter.writeDoc(slug, JSON.stringify(source), { ifMatch: cur.etag });
    } else {
      fs.writeFileSync(db.tenantFile(slug), JSON.stringify(source, null, 2));
    }
  }
  if (logoFile) await db.saveLogoFile(slug, logoFile, logoBuffer);

  console.log(`Pronto! Salão "${slug}": ${source.appointments.length} agendamento(s), ${source.services.length} serviço(s), ${source.customers.length} cadastro(s).`);
  console.log(`Acesse: /${slug}  e o painel em /${slug}/admin`);
  console.log('Obs.: no painel antigo o login usava o cookie "adm"; agora é um cookie por salão, então será preciso entrar de novo (a senha é a mesma).');
})().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
