// Outgoing mail. Development uses MAIL_TRANSPORT=log, which writes the code to the API log instead of sending.
import type { ServerConfig } from '@acm/core/config';
import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import { signInCodeMail } from './templates.ts';

export type Mailer = { sendSignInCode(to: string, code: string): Promise<void> };

export function createMailer(cfg: ServerConfig, log: FastifyBaseLogger): Mailer {
  if (cfg.MAIL_TRANSPORT === 'log') {
    return {
      async sendSignInCode(to, code) {
        log.warn({ mail: 'sign-in-code', to: '[dev]', code }, `DEV MAIL to ${to}: sign-in code ${code}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });
  return {
    async sendSignInCode(to, code) {
      await transport.sendMail({ from: cfg.SMTP_FROM, to, ...signInCodeMail(code, cfg.PUBLIC_ORIGIN) });
    },
  };
}
