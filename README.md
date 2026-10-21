# Sistema de agendamento para salão

Express + EJS + Tailwind. Site de agendamento para as clientes e painel do salão (agenda, pagamentos, clientes, relatórios e personalização de logo, nome e cores).

**Sem banco de dados:** todos os dados ficam em um arquivo JSON.

## Rodar no seu computador

```bash
npm install
npm start
```

Abra http://localhost:3000. Ao abrir `/admin` pela primeira vez, você faz o cadastro do salão (logo, nome, CPF/CNPJ, e-mail e senha).
Localmente os dados ficam em `data/db.json` e as logos em `public/uploads`. Copie `.env.example` para `.env` para configurar o envio de e-mail.

## Publicar na Vercel

A Vercel apaga os arquivos entre uma visita e outra, então um `db.json` comum se perderia. Em produção o **mesmo arquivo JSON** é guardado no **Vercel Blob** (armazenamento de arquivos da Vercel, com plano gratuito). O app detecta sozinho: com `BLOB_READ_WRITE_TOKEN` ele usa o Blob; sem ela usa o arquivo local.

1. **Suba o projeto** para o GitHub (`node_modules`, `data` e `.env` já estão no `.gitignore`).
2. Na Vercel: **Add New → Project**, escolha o repositório e **Deploy**. O `vercel.json` já define o build e a função.
3. **Conecte o Blob:** no projeto, aba **Storage → Create Database/Store → Blob**. Deixe o acesso **Private**, escolha a região e **conecte ao projeto** (todos os ambientes). Isso cria a variável `BLOB_READ_WRITE_TOKEN` sozinha.
4. **Variáveis de ambiente** (Settings → Environment Variables):

   | Variável | Para quê |
   | --- | --- |
   | `BLOB_READ_WRITE_TOKEN` | já criada pelo passo 3 |
   | `SESSION_SECRET` | texto longo e aleatório que assina o login do painel (**obrigatório em produção**) |
   | `PUBLIC_URL` | endereço do site, ex.: `https://meusalao.vercel.app` (link do e-mail de recuperação) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | envio do e-mail de recuperação de senha (veja `.env.example`) |

5. **Redeploy** (Deployments → ⋯ → Redeploy) para as variáveis valerem.
6. Abra `https://seu-site.vercel.app/admin`: aparece o **cadastro do salão** (primeiro acesso). Faça-o logo após publicar, pois quem abrir primeiro cria o acesso.

> Gerar um `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Se o Blob ainda não estiver conectado, o site mostra "Configuração pendente" explicando o que falta, em vez de dar erro.

### Levar os dados que já existem no seu computador

Se você já usou o sistema localmente e quer manter agendamentos, serviços e clientes:

```bash
# PowerShell (pegue o token em Vercel → Storage → seu Blob → aba ".env.local")
$env:BLOB_READ_WRITE_TOKEN="cole-aqui-o-token"; npm run migrate:db
```

O script copia `data/db.json` (e a logo enviada) para o Blob. Se o Blob já tiver um salão cadastrado, ele pede `--force` para sobrescrever.

## Como funciona em produção

- **Dados:** um arquivo `salao/db.json` privado no Blob; logos em `logos/`. Nada é público: o site lê e entrega pelo servidor.
- **Gravações seguras:** cada gravação só vale se o arquivo não mudou desde que o pedido o leu (ETag). Se duas pessoas gravarem ao mesmo tempo, o pedido que "perdeu" é refeito automaticamente com os dados novos. No teste, 8 pedidos simultâneos para o mesmo horário resultaram em 1 aceito, e 6 pedidos em horários diferentes foram todos gravados.
- **Login do painel:** cookie assinado (não depende de memória do servidor). Trocar ou redefinir a senha encerra as outras sessões.
- **E-mail de recuperação:** enviado antes de a resposta terminar (necessário em serverless).

## Limites a ter em mente

- É um único arquivo JSON: serve bem para um salão (milhares de agendamentos). Para muito mais volume, vale migrar para um banco de dados.
- Cada visita lê o arquivo no Blob (uma chamada); o plano gratuito comporta o uso normal de um salão.
- O limite de pedidos da recuperação de senha (5 por hora por IP) é em memória, então vale por instância; o intervalo mínimo de 1 minuto entre e-mails é global (guardado no arquivo de dados).
- Para o domínio próprio: Vercel → Settings → Domains, e atualize `PUBLIC_URL`.
