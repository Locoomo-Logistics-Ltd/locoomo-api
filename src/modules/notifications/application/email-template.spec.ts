import { renderEmail } from './email-template';

describe('renderEmail', () => {
  it('escapes every user-supplied value in the HTML part', () => {
    const { html } = renderEmail({
      greetingName: '<b>Ada</b>',
      heading: 'Order <script>',
      blocks: [
        { kind: 'paragraph', text: 'a & b' },
        { kind: 'details', rows: [{ label: 'Store', value: '"Evil" <i>' }] },
        { kind: 'button', label: 'Go', url: 'https://x.test/?a=1&b="2"' },
      ],
    });

    expect(html).not.toContain('<b>Ada</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;i&gt;');
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });

  it('produces a plain-text part carrying the same content', () => {
    const { text } = renderEmail({
      greetingName: 'Ada',
      heading: 'Your code',
      blocks: [
        { kind: 'code', label: 'Collection code', value: '482913' },
        { kind: 'button', label: 'Track parcel', url: 'https://t.test/1' },
        { kind: 'list', items: ['one', 'two'] },
      ],
      footnote: 'You got this because…',
    });

    expect(text).toContain('Hi Ada,');
    expect(text).toContain('Collection code: 482913');
    expect(text).toContain('Track parcel: https://t.test/1');
    expect(text).toContain('- one\n- two');
    expect(text).toContain('You got this because…');
  });
});
