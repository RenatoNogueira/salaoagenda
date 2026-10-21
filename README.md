# Plataforma de agendamento para salões (multiempresa)

Express + EJS + Tailwind. **Vários salões** (empresas) no mesmo sistema, cada um com o seu endereço, site de agendamento, painel e dados, totalmente separados. Sem banco de dados: cada salão é um arquivo JSON.

```
https://seusite.com/                  página da plataforma ("Criar meu salão")
https://seusite.com/criar             cadastro de um salão novo
https://seusite.com/studiobela        site de agendamento do salão "studiobela"
https://seusite.com/studiobela/admin  painel desse salão
```

## Como o isolamento funciona

- **Endereço próprio:** cada salão escolhe um endereço (`/studiobela`) no cadastro. Ele não pode ser trocado depois e nunca é reaproveitado: se já existe, o cadastro é recusado e **nada é sobrescrito**.
- **Dados separados:** cada salão tem o próprio arquivo (`data/<salao>/db.json` no computador, `tenants/<salao>/db.json` no Blob). Um pedido só carrega o arquivo do salão da URL.
- **Logins separados:** o cookie do painel é por salão (nome e caminho próprios) e a assinatura inclui o endereço e a senha do salão. Um cookie de um salão não abre o painel de outro, nem se for copiado.
- **Clientes separadas:** o cadastro de cliente (nome + telefone) também é por salão. O mesmo telefone em dois salões gera dois cadastros independentes.
- **Gravações seguras:** pedidos no mesmo salão são conferidos por ETag (sem horário duplicado nem perda de alterações); salões diferentes nunca disputam nada.

## Rodar no seu computador

```bash
npm install
npm start
```

Abra http://localhost:3000 e clique em **Criar meu salão**. Os dados ficam em `data/<salao>/db.json`. Copie `.env.example` para `.env` para configurar e-mail e outras opções.

## Publicar na Vercel

A Vercel apaga os arquivos entre uma visita e outra, então um `db.json` comum se perderia. Em produção cada salão é um arquivo JSON no **Vercel Blob**. O app detecta sozinho: com as variáveis do Blob ele usa o Blob; sem elas usa arquivos locais.

1. **Suba o projeto** para o GitHub (`node_modules`, `data` e `.env` já estão no `.gitignore`).
2. Na Vercel: **Add New → Project**, escolha o repositório e **Deploy**. O `vercel.json` já define o build e a função.
3. **Conecte o Blob:** no projeto, aba **Storage → Create → Blob** (acesso **Private**) e conecte ao projeto, em todos os ambientes.
4. **Variáveis de ambiente** (Settings → Environment Variables):

   | Variável | Para quê |
   | --- | --- |
   | `BLOB_READ_WRITE_TOKEN` ou `BLOB_STORE_ID` | criadas sozinhas ao conectar o Blob |
   | `SESSION_SECRET` | texto longo e aleatório que assina os logins (**obrigatório em produção**) |
   | `PUBLIC_URL` | endereço do site, ex.: `https://meusite.vercel.app` (link do e-mail de recuperação) |
   | `PLATFORM_NAME` | nome da plataforma na página inicial (opcional) |
   | `PLATFORM_SIGNUP_CODE` | código de convite para criar salões (opcional; sem ele qualquer pessoa cria) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | e-mail de recuperação de senha (veja `.env.example`) |

5. **Redeploy** para as variáveis valerem.
6. Abra `https://seu-site.vercel.app/criar` e cadastre o primeiro salão.

> Gerar um `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Quem pode criar salões?** Por padrão, qualquer pessoa que abrir `/criar` (com limite de 5 cadastros por hora por IP). Para controlar, defina `PLATFORM_SIGNUP_CODE`: o formulário passa a pedir o código de convite.

Se o Blob ainda não estiver conectado, o site mostra "Configuração pendente" explicando o que falta.

### Migrar o salão que você já tinha (versão de um salão só)

Antes o sistema atendia um único salão (na raiz do site). Para levar esses dados para o formato novo:

- **Automático (mais simples):** defina `MIGRATE_LEGACY_TO=meusalao` (o endereço que o salão terá) nas variáveis do ambiente (na Vercel, em Settings → Environment Variables, e Redeploy; no computador, no `.env`). No primeiro acesso a `/meusalao`, os dados antigos (agenda, clientes, serviços, senha, logo) são copiados. Os arquivos antigos **não são apagados**. Depois pode remover a variável.
- **Por comando:** `npm run migrate:db -- meusalao` (copia `data/db.json`) ou `npm run migrate:db -- meusalao --from-blob` (copia o salão antigo do Blob). Use `--force` para sobrescrever um salão que já exista nesse endereço.

A senha do painel é a mesma de antes; só é preciso entrar de novo, porque o cookie agora é por salão.

## Limites a ter em mente

- Cada salão é um arquivo JSON: serve bem para salões (milhares de agendamentos). Para volumes muito maiores, vale migrar para um banco de dados.
- Cada visita lê o arquivo do salão no Blob (uma chamada); o plano gratuito comporta o uso normal de alguns salões.
- O endereço do salão (`/studiobela`) não muda e, por ser parte da URL, aparece em links e favoritos.
- Não há (ainda) um painel do dono da plataforma para listar, suspender ou excluir salões; isso é feito diretamente no Blob/arquivos.
- O limite de pedidos da recuperação de senha (5 por hora por IP) é em memória, então vale por instância; o intervalo mínimo de 1 minuto entre e-mails é guardado no arquivo do salão.
- Para domínio próprio: Vercel → Settings → Domains, e atualize `PUBLIC_URL`.
