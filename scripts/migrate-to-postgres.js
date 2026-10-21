// Copia os dados do modo local (data/db.json + logo em public/uploads) para o PostgreSQL.
// Uso:  DATABASE_URL="postgres://..." npm run migrate:db
// É seguro rodar de novo: pede confirmação com --force se o banco já tiver um salão cadastrado.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pg = require('../lib/db-pg');
const { defaults, normalize } = require('../lib/db');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const file = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'db.json') : path.join(__dirname, '..', 'data', 'db.json');
const force = process.argv.includes('--force');

(async () => {
  if (!url) throw new Error('Defina DATABASE_URL (a string de conexão do Postgres).');
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);

  const local = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  const ctx = await pg.begin(url, defaults(), true);
  try {
    if (ctx.data.owner && !force) {
      throw new Error('O banco já tem um salão cadastrado. Para sobrescrever, rode novamente com --force.');
    }

    // a logo enviada vira um registro na tabela assets
    const logo = local.settings.logo || '';
    if (logo.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '..', 'public', 'uploads', path.basename(logo));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext];
        const id = crypto.randomBytes(12).toString('hex');
        await pg.saveAsset(url, defaults(), id, mime, fs.readFileSync(filePath));
        local.settings.logo = `/media/${id}${ext}`;
        console.log('Logo enviada para o banco:', local.settings.logo);
      } else {
        local.settings.logo = '/img/logo-default.svg';
        console.log('Aviso: arquivo da logo não encontrado; usando a logo padrão.');
      }
    }

    ctx.data = local;
    ctx.dirty = true;
    await ctx.commit();
    console.log(`Pronto! ${local.appointments.length} agendamento(s), ${local.services.length} serviço(s), ${local.customers.length} cadastro(s) copiados.`);
  } catch (err) {
    await ctx.abort();
    throw err;
  } finally {
    await pg.close();
  }
})().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
