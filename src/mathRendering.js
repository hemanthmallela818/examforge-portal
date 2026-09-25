import katex from 'katex';

// Pure question-text rendering: plain text is HTML-escaped, and only explicitly
// delimited math ($...$, $$...$$, \(...\), \[...\]) is handed to KaTeX with
// trust disabled, so neither prose nor LaTeX can inject markup or URLs.

export const KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  trust: false,
  strict: 'warn',
  output: 'htmlAndMathml'
});

/**
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * @param {string | null | undefined} str
 * @param {boolean} [isDisplay]
 * @returns {string}
 */
export function renderKaTeX(str, isDisplay = false) {
  if (!str) return '';
  try {
    return katex.renderToString(str.trim(), { ...KATEX_OPTIONS, displayMode: isDisplay });
  } catch (err) {
    console.warn('KaTeX renderToString error:', err);
    return escapeHtml(str);
  }
}

// Every alternative is explicitly delimited, so each match starts and ends with
// one of the four delimiter pairs below:
// 1. $$ ... $$ (display math)
// 2. $ ... $ (inline math with balanced $; the body cannot start with $)
// 3. \[ ... \] (display math)
// 4. \( ... \) (inline math)
// Render only explicitly delimited math. Matching a bare `\\command` can
// swallow normal prose after a backslash and turn question text into math.
const mathRegex = /(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;

/** @param {string} matchedStr */
const renderDelimited = (matchedStr) => {
  if (matchedStr.startsWith('$$')) return renderKaTeX(matchedStr.slice(2, -2), true);
  if (matchedStr.startsWith('\\[')) return renderKaTeX(matchedStr.slice(2, -2), true);
  if (matchedStr.startsWith('\\(')) return renderKaTeX(matchedStr.slice(2, -2), false);
  return renderKaTeX(matchedStr.slice(1, -1), false); // $ ... $
};

/**
 * @param {unknown} rawText
 * @returns {string}
 */
export function parseAndRenderMath(rawText) {
  if (!rawText && rawText !== 0) return '';
  let textStr = String(rawText);

  // Normalize dangling unescaped single '$' signs
  const dollarMatches = textStr.match(/(?<!\\)\$/g);
  if (dollarMatches && dollarMatches.length % 2 !== 0) {
    if (textStr.endsWith('$')) {
      textStr = textStr.slice(0, -1);
    } else if (textStr.startsWith('$')) {
      textStr = textStr.slice(1);
    }
  }

  const resultParts = [];
  let lastIndex = 0;
  let match;
  mathRegex.lastIndex = 0;

  while ((match = mathRegex.exec(textStr)) !== null) {
    if (match.index > lastIndex) {
      resultParts.push(escapeHtml(textStr.substring(lastIndex, match.index)));
    }
    resultParts.push(renderDelimited(match[0]));
    lastIndex = mathRegex.lastIndex;
  }

  if (lastIndex < textStr.length) {
    resultParts.push(escapeHtml(textStr.substring(lastIndex)));
  }

  return resultParts.join('');
}
