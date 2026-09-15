import { describe, expect, it } from 'vitest';
import { parseBboxXhtml } from './bbox.js';

const SAMPLE = `<!DOCTYPE html><html><body><doc>
  <page width="595.000000" height="842.000000">
    <word xMin="523.000290" yMin="25.456000" xMax="543.880290" yMax="50.832000">(١)</word>
    <word xMin="71.695300" yMin="27.456000" xMax="77.255300" yMax="52.832000">&amp;&quot;&#1633;</word>
  </page>
  <page width="481.890000" height="680.315000">
  </page>
</doc></body></html>`;

describe('parseBboxXhtml', () => {
  it('разбирает страницы и слова с координатами', () => {
    const pages = parseBboxXhtml(SAMPLE);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ page: 1, width: 595, height: 842 });
    expect(pages[0]?.words[0]).toEqual({
      text: '(١)',
      xMin: 523.00029,
      yMin: 25.456,
      xMax: 543.88029,
      yMax: 50.832,
    });
    expect(pages[1]).toMatchObject({ page: 2, width: 481.89, words: [] });
  });

  it('декодирует HTML-сущности', () => {
    expect(parseBboxXhtml(SAMPLE)[0]?.words[1]?.text).toBe('&"١');
  });
});
