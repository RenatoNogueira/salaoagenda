// Armazenamento em PostgreSQL (Neon, Supabase, Vercel Postgres...) para hospedagens sem disco, como a Vercel.
// Os dados do salão ficam em UM documento JSON (tabela kv, chave "db"), igual ao arquivo db.json do modo local.
// Cada pedido que altera dados roda numa transação com "SELECT ... FOR UPDATE": pedidos de escrita
// são atendidos um por vez, o que impede dois agendamentos no mesmo horário e perda de alterações.
const { Pool } = require('pg');

let pool;
let ready;

function getPool(url) {
  if (!pool) {
    pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX) || 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    pool.on('error', (err) => console.error('Erro no pool do Postgres:', err.message));
  }
  return pool;
}

/** Cria as tabelas (uma vez por instância) e grava o documento inicial se ainda não existir. */
function init(url, seedDoc) {
  if (!ready) {
    ready = (async () => {
      const p = getPool(url);
      await p.query(`CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await p.query(`CREATE TABLE IF NOT EXISTS assets (id text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await p.query(`INSERT INTO kv (k, v) VALUES ('db', $1::jsonb) ON CONFLICT (k) DO NOTHING`, [JSON.stringify(seedDoc)]);
    })().catch((err) => {
      ready = null; // tenta de novo no próximo pedido
      throw err;
    });
  }
  return ready;
}

/** Abre o contexto de um pedido. Escrita: transação com a linha travada. Leitura: um SELECT simples. */
async function begin(url, seedDoc, write) {
  await init(url, seedDoc);
  const p = getPool(url);
  if (!write) {
    const r = await p.query(`SELECT v FROM kv WHERE k = 'db'`);
    return { data: r.rows[0].v, write: false, dirty: false, done: true };
  }
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT v FROM kv WHERE k = 'db' FOR UPDATE`);
    const ctx = {
      data: r.rows[0].v,
      write: true,
      dirty: false,
      done: false,
      // grava (se houve mudança) e libera a trava; pode ser chamado mais de uma vez
      async commit() {
        if (ctx.done) return;
        ctx.done = true;
        try {
          if (ctx.dirty) await client.query(`UPDATE kv SET v = $1::jsonb, updated_at = now() WHERE k = 'db'`, [JSON.stringify(ctx.data)]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      // descarta as mudanças (ex.: pedido que terminou em erro)
      async abort() {
        if (ctx.done) return;
        ctx.done = true;
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      },
    };
    return ctx;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
}

async function saveAsset(url, seedDoc, id, mime, buffer) {
  await init(url, seedDoc);
  await getPool(url).query(`INSERT INTO assets (id, mime, data) VALUES ($1, $2, $3)`, [id, mime, buffer]);
}

async function getAsset(url, seedDoc, id) {
  await init(url, seedDoc);
  const r = await getPool(url).query(`SELECT mime, data FROM assets WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function deleteAsset(url, seedDoc, id) {
  await init(url, seedDoc);
  await getPool(url).query(`DELETE FROM assets WHERE id = $1`, [id]);
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  ready = null;
}

module.exports = { begin, saveAsset, getAsset, deleteAsset, close, init };
