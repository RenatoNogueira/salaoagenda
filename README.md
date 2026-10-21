# Sistema de agendamento para salão

Express + EJS + Tailwind. Site de agendamento para as clientes e painel do salão (agenda, pagamentos, clientes, relatórios e personalização de logo, nome e cores).

## Rodar no seu computador

```bash
npm install
npm start
```

Abra http://localhost:3000. Ao abrir `/admin` pela primeira vez, você faz o cadastro do salão (logo, nome, CPF/CNPJ, e-mail e senha).
Localmente os dados ficam em `data/db.json` e as logos em `public/uploads`. Copie `.env.example` para `.env` para configurar o envio de e-mail.

## Publicar na Vercel

A Vercel não guarda arquivos entre uma visita e outra, por isso em produção os dados ficam em um **PostgreSQL**.
O app detecta isso sozinho: com `DATABASE_URL` definido ele usa o banco, sem ela usa o arquivo local.

1. **Suba o projeto** para um repositório no GitHub (a pasta `node_modules`, `data` e `.env` já estão no `.gitignore`).
2. Na Vercel: **Add New → Project**, escolha o repositório e **Deploy**. Não precisa mudar nada: o `vercel.json` já define o build (`npm run build:css`) e a função (`api/index.js`).
3. **Crie o banco:** no projeto, aba **Storage → Create Database → Neon (Postgres)** e conecte ao projeto. Isso cria `DATABASE_URL` sozinha. (Qualquer Postgres serve: Neon, Supabase, Railway...)
4. **Variáveis de ambiente** (Settings → Environment Variables):

   | Variável | Para quê |
   | --- | --- |
   | `DATABASE_URL` | já criada pelo passo 3 |
   | `SESSION_SECRET` | texto longo e aleatório que assina o login do painel (**obrigatório em produção**) |
   | `PUBLIC_URL` | endereço do site, ex.: `https://meusalao.vercel.app` (usado no link do e-mail de recuperação) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | envio do e-mail de recuperação de senha (veja `.env.example`) |

5. **Redeploy** (Deployments → ⋯ → Redeploy) para as variáveis valerem.
6. Abra `https://seu-site.vercel.app/admin`: aparece o **cadastro do salão** (primeiro acesso). Faça-o logo após publicar, pois quem abrir primeiro cria o acesso.

> Gerar um `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Levar os dados que já existem no seu computador

Se você já usou o sistema localmente e quer manter agendamentos, serviços e clientes:

```bash
# PowerShell
$env:DATABASE_URL="cole-aqui-a-url-do-banco"; npm run migrate:db
```

O script copia `data/db.json` (e a logo enviada) para o banco. Se o banco já tiver um salão cadastrado, ele pede `--force` para sobrescrever.

## Como funciona em produção

- **Dados:** um documento JSON no Postgres (tabela `kv`); logos na tabela `assets`. As tabelas são criadas automaticamente.
- **Sem dois agendamentos no mesmo horário:** pedidos que alteram dados rodam um por vez (trava de linha no banco).
- **Login do painel:** cookie assinado (não depende de memória do servidor). Trocar ou redefinir a senha encerra as outras sessões.
- **Logo:** guardada no banco e servida em `/media/...`.
- **E-mail de recuperação:** enviado antes de a resposta terminar (necessário em serverless).

## Limites a ter em mente

- O limite de pedidos da recuperação de senha (5 por hora por IP) é em memória, então vale por instância; o intervalo mínimo de 1 minuto entre e-mails é global (guardado no banco).
- Plano gratuito da Vercel: funções de até 60 s; o app usa no máximo ~30 s (`vercel.json`).
- Para o domínio próprio: Vercel → Settings → Domains, e atualize `PUBLIC_URL`.
