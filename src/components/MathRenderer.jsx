import { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import { parseAndRenderMath } from '../mathRendering';

export { parseAndRenderMath };

// parseAndRenderMath escapes all plain text and renders delimited math with
// KaTeX (trust: false), so its output is safe to inject.
/** @param {{ text: unknown, style?: import('react').CSSProperties, className?: string }} props */
const MathRenderer = ({ text, style, className }) => {
  const renderedHtml = useMemo(() => parseAndRenderMath(text), [text]);

  return (
    <span
      style={{ display: 'inline', ...style }}
      className={className}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
};

export default MathRenderer;
