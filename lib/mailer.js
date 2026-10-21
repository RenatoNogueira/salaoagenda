// Envio de e-mails (recuperação de senha). Configure o SMTP por variáveis de ambiente (veja .env.example).
// Sem SMTP configurado nada é enviado: o conteúdo vai para o console do servidor (útil em testes locais).
const nodemailer = require('nodemailer');

const configured = () => Boolean(process.env.SMTP_HOST);

let transporter;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    });
  }
  return transporter;
}

async function send({ to, subject, text, html }) {
  if (!configured()) {
    console.log(`\n[e-mail NÃO enviado: SMTP não configurado]\nPara: ${to}\nAssunto: ${subject}\n${text}\n`);
    return { sent: false };
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  await getTransporter().sendMail({ from, to, subject, text, html });
  return { sent: true };
}

module.exports = { send, configured };
