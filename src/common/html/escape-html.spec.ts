import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry\'s</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('A small box of documents')).toBe(
      'A small box of documents',
    );
  });
});
