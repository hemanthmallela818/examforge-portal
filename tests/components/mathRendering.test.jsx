import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { KATEX_OPTIONS, escapeHtml, parseAndRenderMath } from '../../src/mathRendering';
import MathRenderer from '../../src/components/MathRenderer';

// Parse rendered HTML into a detached DOM so assertions check real elements and
// attributes rather than substrings of serialized markup.
const toDom = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

const dangerousAttributes = (host) => [...host.querySelectorAll('*')].flatMap(element =>
  [...element.attributes]
    .filter(attr => /^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value) || ['href', 'src', 'xlink:href'].includes(attr.name))
    .map(attr => `${element.tagName}[${attr.name}=${attr.value}]`)
);

const assertInert = (html) => {
  const host = toDom(html);
  expect(host.querySelector('script, img, iframe, a, object, embed, svg foreignObject')).toBeNull();
  expect(dangerousAttributes(host)).toEqual([]);
  return host;
};

beforeEach(() => {
  // KaTeX reports unsupported/disabled commands through console.warn in strict:'warn' mode.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
  });

  it('stringifies non-string input', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('KaTeX options', () => {
  it('keeps trust disabled and never throws on bad input', () => {
    expect(KATEX_OPTIONS).toMatchObject({ trust: false, throwOnError: false, strict: 'warn', output: 'htmlAndMathml' });
    expect(Object.isFrozen(KATEX_OPTIONS)).toBe(true);
  });
});

describe('parseAndRenderMath: plain text', () => {
  it('returns an empty string for empty input but renders zero', () => {
    expect(parseAndRenderMath('')).toBe('');
    expect(parseAndRenderMath(null)).toBe('');
    expect(parseAndRenderMath(undefined)).toBe('');
    expect(parseAndRenderMath(0)).toBe('0');
  });

  it('escapes plain text without invoking KaTeX', () => {
    expect(parseAndRenderMath('Tom & Jerry <3 "quotes"')).toBe('Tom &amp; Jerry &lt;3 &quot;quotes&quot;');
  });

  it('does not treat a bare backslash command as math', () => {
    expect(parseAndRenderMath('Use \\frac{1}{2} here')).toBe('Use \\frac{1}{2} here');
  });

  it('neutralises HTML payloads in plain text', () => {
    for (const payload of [
      '<img src=x onerror="alert(1)">',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(1)">click</a>',
      '<svg onload=alert(1)>',
      '<iframe src="javascript:alert(1)"></iframe>'
    ]) {
      const html = parseAndRenderMath(`Question ${payload} end`);
      const host = assertInert(html);
      expect(host.textContent).toBe(`Question ${payload} end`);
    }
  });
});

describe('parseAndRenderMath: delimited math', () => {
  it('renders inline $...$ with KaTeX and escapes the surrounding text', () => {
    const host = toDom(parseAndRenderMath('If <x> then $x^2$ & more'));
    expect(host.querySelectorAll('.katex')).toHaveLength(1);
    expect(host.querySelector('.katex-display')).toBeNull();
    expect(host.querySelector('annotation').textContent).toBe('x^2');
    expect(host.innerHTML.startsWith('If &lt;x&gt; then ')).toBe(true);
    expect(host.innerHTML.endsWith(' &amp; more')).toBe(true);
  });

  it('renders $$...$$ and \\[...\\] as display math', () => {
    for (const text of ['$$\\frac{1}{2}$$', '\\[\\frac{1}{2}\\]']) {
      const host = toDom(parseAndRenderMath(text));
      expect(host.querySelector('.katex-display')).not.toBeNull();
      expect(host.querySelector('math').getAttribute('display')).toBe('block');
      expect(host.querySelector('annotation').textContent).toBe('\\frac{1}{2}');
    }
  });

  it('renders \\(...\\) as inline math', () => {
    const host = toDom(parseAndRenderMath('Value \\(a+b\\) now'));
    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector('.katex-display')).toBeNull();
    expect(host.querySelector('annotation').textContent).toBe('a+b');
  });

  it('renders several expressions in one string in order', () => {
    const host = toDom(parseAndRenderMath('$a$ then $$b$$ then \\(c\\)'));
    expect([...host.querySelectorAll('annotation')].map(node => node.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('renders an escaped dollar inside inline math', () => {
    const host = toDom(parseAndRenderMath('$\\$5 + x$'));
    expect(host.querySelector('annotation').textContent).toBe('\\$5 + x');
  });
});

describe('parseAndRenderMath: dollar edge cases', () => {
  it('drops a single dangling dollar at the end or start', () => {
    expect(parseAndRenderMath('$x^2')).toBe('x^2');
    expect(parseAndRenderMath('x^2$')).toBe('x^2');
  });

  it('keeps a lone dollar in the middle as text', () => {
    expect(parseAndRenderMath('Price $5 only')).toBe('Price $5 only');
  });

  it('keeps escaped dollars as text', () => {
    expect(parseAndRenderMath('Cost \\$5 and \\$6')).toBe('Cost \\$5 and \\$6');
  });

  it('does not render an empty $$ pair or $$ with no close', () => {
    expect(parseAndRenderMath('a $$ b')).toBe('a $$ b');
    expect(parseAndRenderMath('$$')).toBe('$$');
  });

  it('is stateless across repeated calls', () => {
    const first = parseAndRenderMath('$x$ and $y$');
    expect(parseAndRenderMath('$x$ and $y$')).toBe(first);
  });
});

describe('parseAndRenderMath: payloads inside math', () => {
  it.each([
    ['img onerror', '$<img src=x onerror=alert(1)>$'],
    ['script tag', '$<script>alert(1)</script>$'],
    ['href javascript', '$\\href{javascript:alert(1)}{click}$'],
    ['url javascript', '$\\url{javascript:alert(1)}$'],
    ['htmlClass', '$\\htmlClass{evil}{x}$'],
    ['htmlId', '$\\htmlId{evil}{x}$'],
    ['htmlStyle', '$\\htmlStyle{background:url(javascript:alert(1))}{x}$'],
    ['htmlData', '$\\htmlData{onclick=alert(1)}{x}$'],
    ['includegraphics', '$\\includegraphics{https://attacker.example/a.png}$'],
    ['display href', '$$\\href{javascript:alert(1)}{x}$$'],
    ['bracket href', '\\[\\href{javascript:alert(1)}{x}\\]']
  ])('%s is rendered inert', (_name, payload) => {
    const host = assertInert(parseAndRenderMath(payload));
    expect(host.querySelector('.evil, #evil, [data-onclick], [style*="javascript"]')).toBeNull();
    expect(host.querySelector('.katex')).not.toBeNull();
  });
});

describe('MathRenderer component', () => {
  it('injects the rendered markup into an inline span with caller class and style', () => {
    const { container } = render(<MathRenderer text="Area $\pi r^2$ <b>bold</b>" className="custom" style={{ color: 'red' }} />);
    const span = container.firstChild;
    expect(span.tagName).toBe('SPAN');
    expect(span.className).toBe('custom');
    expect(span.style.display).toBe('inline');
    expect(span.style.color).toBe('red');
    expect(span.querySelector('.katex')).not.toBeNull();
    expect(span.querySelector('b')).toBeNull();
    expect(span.textContent).toContain('<b>bold</b>');
  });
});
