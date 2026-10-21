// Copia os dados do modo local (data/db.json + logo em public/uploads) para o Vercel Blob.
// Uso:  BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..." npm run migrate:db
// Se o Blob já tiver um salão cadastrado, só sobrescreve com --force.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adapter = process.env.BLOB_ADAPTER_MODULE ? require(path.resolve(process.env.BLOB_ADAPTER_MODULE)) : require('../lib/blob-adapter');
const { normalize } = require('../lib/db');

const file = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'db.json') : path.join(__dirname, '..', 'data', 'db.json');
const force = process.argv.includes('--force');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

(async () => {
  if (!process.env.BLOB_ADAPTER_MODULE && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Defina BLOB_READ_WRITE_TOKEN (Vercel → Storage → seu Blob → aba ".env.local" ou "Connect").');
  }
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);

  const local = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  const existing = await adapter.readDoc();
  if (existing && JSON.parse(existing.text).owner && !force) {
    throw new Error('O Blob já tem um salão cadastrado. Para sobrescrever, rode novamente com --force.');
  }

  // a logo enviada vira um arquivo privado no Blob
  const logo = local.settings.logo || '';
  if (logo.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, '..', 'public', 'uploads', path.basename(logo));
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const name = `${crypto.randomBytes(12).toString('hex')}${ext}`;
      await adapter.putFile(name, fs.readFileSync(filePath), MIME[ext]);
      local.settings.logo = `/media/${name}`;
      console.log('Logo enviada ao Blob:', local.settings.logo);
    } else {
      local.settings.logo = '/img/logo-default.svg';
      console.log('Aviso: arquivo da logo não encontrado; usando a logo padrão.');
    }
  }

  const text = JSON.stringify(local);
  if (existing) await adapter.writeDoc(text, { ifMatch: existing.etag });
  else await adapter.createDoc(text);
  console.log(`Pronto! ${local.appointments.length} agendamento(s), ${local.services.length} serviço(s), ${local.customers.length} cadastro(s) copiados.`);
})().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
