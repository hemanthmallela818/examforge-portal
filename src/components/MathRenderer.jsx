import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderKaTeX(str, isDisplay = false) {
  if (!str) return '';
  try {
    return katex.renderToString(str.trim(), {
      displayMode: isDisplay,
      throwOnError: false,
      trust: false,
      strict: 'warn',
      output: 'htmlAndMathml'
    });
  } catch (err) {
    console.warn("KaTeX renderToString error:", err);
    return escapeHtml(str);
  }
}

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

  // Regular expression to match:
  // 1. $$ ... $$ (display math)
  // 2. $ ... $ (inline math with balanced $)
  // 3. \[ ... \] (display math)
  // 4. \( ... \) (inline math)
  // Render only explicitly delimited math. Matching a bare `\\command` can
  // swallow normal prose after a backslash and turn question text into math.
  const mathRegex = /(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;

  const resultParts = [];
  let lastIndex = 0;
  let match;

  while ((match = mathRegex.exec(textStr)) !== null) {
    const matchStart = match.index;
    const matchEnd = mathRegex.lastIndex;

    // Push preceding plain text
    if (matchStart > lastIndex) {
      resultParts.push(escapeHtml(textStr.substring(lastIndex, matchStart)));
    }

    const matchedStr = match[0];

    if (matchedStr.startsWith('$$') && matchedStr.endsWith('$$') && matchedStr.length >= 4) {
      resultParts.push(renderKaTeX(matchedStr.slice(2, -2), true));
    } else if (matchedStr.startsWith('\\[') && matchedStr.endsWith('\\]') && matchedStr.length >= 4) {
      resultParts.push(renderKaTeX(matchedStr.slice(2, -2), true));
    } else if (matchedStr.startsWith('$') && matchedStr.endsWith('$') && matchedStr.length >= 2) {
      resultParts.push(renderKaTeX(matchedStr.slice(1, -1), false));
    } else if (matchedStr.startsWith('\\(') && matchedStr.endsWith('\\)') && matchedStr.length >= 4) {
      resultParts.push(renderKaTeX(matchedStr.slice(2, -2), false));
    } else {
      // Standalone LaTeX expression (e.g. \frac{1}{2}+e)
      resultParts.push(renderKaTeX(matchedStr, false));
    }

    lastIndex = matchEnd;
  }

  // Push trailing plain text
  if (lastIndex < textStr.length) {
    resultParts.push(escapeHtml(textStr.substring(lastIndex)));
  }

  return resultParts.join('');
}

const MathRenderer = ({ text, style, className }) => {
  const renderedHtml = useMemo(() => {
    return parseAndRenderMath(text);
  }, [text]);

  return (
    <span 
      style={{ display: 'inline', ...style }} 
      className={className}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
};

export default MathRenderer;
