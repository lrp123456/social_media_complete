import { sanitizeSnapshot } from '../snapshotSanitizer';

describe('sanitizeSnapshot', () => {
  it('redacts csrf_token value in JSON', () => {
    const input = '{"csrf_token":"abcdef1234567890","ok":1}';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toMatch(/abc\*\*\*REDACTED\*\*\*/);
    expect(out).toContain('"ok":1');
  });

  it('redacts Bearer authorization header', () => {
    const input = 'authorization:Bearer xyz1234567890abc';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toContain('xyz1234567890abc');
    expect(out).toMatch(/xyz\*\*\*REDACTED\*\*\*/);
  });

  it('redacts session_id and X-Token and ticket', () => {
    const input = '{"session_id":"sess1234567890","X-Token":"tok1234567890","ticket":"tkt1234567890"}';
    const out = sanitizeSnapshot(input, 'application/json');
    expect(out).not.toMatch(/sess\d+/);
    expect(out).not.toMatch(/tok\d+/);
    expect(out).not.toMatch(/tkt\d+/);
  });

  it('leaves non-token content untouched', () => {
    const input = '<div class="comment">hello world</div>';
    expect(sanitizeSnapshot(input, 'text/html')).toBe(input);
  });

  it('records which patterns were redacted (via log callback)', () => {
    const redacted: string[] = [];
    sanitizeSnapshot('{"csrf_token":"abcdef1234567890"}', 'application/json', (p) => redacted.push(p));
    expect(redacted).toContain('csrf_token');
  });
});
