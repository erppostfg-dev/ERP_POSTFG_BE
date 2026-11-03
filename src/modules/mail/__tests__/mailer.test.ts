import { describe, expect, it } from 'vitest';
import { rawMessage } from '../mailer.service';

const headers = (raw: string): string[] => raw.split('\r\n\r\n')[0].split('\r\n');

describe('rawMessage', () => {
  it('one To, as the welcome email sends it', () => {
    const h = headers(rawMessage({ to: 'a@example.com', subject: 'Hi', text: 't', html: '<p>t</p>' }, 'b1'));
    expect(h).toContain('To: a@example.com');
    expect(h.some((l) => l.startsWith('Cc:') || l.startsWith('Bcc:'))).toBe(false);
  });

  it('several To, Cc and Bcc (a mailing list); empty lists leave their header out', () => {
    const h = headers(rawMessage({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], bcc: ['d@example.com', ' '], subject: 'S', text: 't', html: 'h' }, 'b1'));
    expect(h).toContain('To: a@example.com, b@example.com');
    expect(h).toContain('Cc: c@example.com');
    expect(h).toContain('Bcc: d@example.com');
    expect(headers(rawMessage({ to: [], bcc: ['d@example.com'], subject: 'S', text: 't', html: 'h' }, 'b1')).some((l) => l.startsWith('To:'))).toBe(false);
  });

  it('attachments: multipart/mixed around the text + HTML, each file base64 in 76-character lines', () => {
    const content = new Uint8Array(200).map((_, i) => i);
    const raw = rawMessage({
      to: 'a@example.com', subject: 'S', text: 't', html: 'h',
      attachments: [{ filename: "Stock-30Oct'26.xlsx", contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content }],
    }, 'b1');
    expect(headers(raw)).toContain('Content-Type: multipart/mixed; boundary="b1"');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="b1-alt"');
    expect(raw).toContain('Content-Disposition: attachment; filename="Stock-30Oct\'26.xlsx"');
    const part = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[3].split('\r\n--b1--')[0];
    expect(part.split('\r\n').every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(part.replace(/\r\n/g, ''), 'base64')).toEqual(Buffer.from(content));
    expect(raw.trimEnd().endsWith('--b1--')).toBe(true);
  });
});
