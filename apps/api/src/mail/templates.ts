// English only for now. When translations arrive, pick the template by the user's locale.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function signInCodeMail(code: string, origin: string) {
  const host = new URL(origin).host;
  return {
    subject: `${code} is your ACM Library code`,
    text: [
      `Your sign-in code is ${code}`,
      '',
      'It expires in 10 minutes and works once.',
      `If you didn't try to sign in to ${host}, you can ignore this email.`,
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f4f1ea;font-family:Helvetica,Arial,sans-serif;color:#1c1a17">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fbf9f4;border:1px solid #d8d2c4">
<tr><td style="padding:28px 28px 8px;font-family:Georgia,serif;font-size:20px">ACM Library</td></tr>
<tr><td style="padding:8px 28px">Your sign-in code is</td></tr>
<tr><td style="padding:8px 28px 16px;font-family:Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px">${esc(code)}</td></tr>
<tr><td style="padding:0 28px 28px;color:#5c574d;font-size:14px">It expires in 10 minutes and works once. If you didn't try to sign in to ${esc(host)}, you can ignore this email.</td></tr>
</table></body></html>`,
  };
}
