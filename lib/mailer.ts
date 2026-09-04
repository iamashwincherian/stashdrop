import nodemailer from "nodemailer";

declare global {
  var __stashdropMailer: ReturnType<typeof nodemailer.createTransport> | undefined;
}

function getTransport() {
  if (!globalThis.__stashdropMailer) {
    const port = Number(process.env.SMTP_PORT) || 587;
    globalThis.__stashdropMailer = nodemailer.createTransport({
      host: process.env.SMTP_SERVER,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },
    });
  }
  return globalThis.__stashdropMailer;
}

export async function sendMail({ to, subject, html }: { to: string; subject: string; html: string }) {
  await getTransport().sendMail({ from: process.env.SMTP_USERNAME, to, subject, html });
}
