import { describe, expect, it } from 'vitest';
import { findMath, withMath } from './math';

const formulas = (source: string) => findMath(source).found.map(({ formula, display }) => (display ? `display:${formula.trim()}` : formula));

describe('findMath', () => {
  // Codex's `unicode_math_preserves_markdown_contexts`, as what is found rather than how it draws.
  it.each([
    [String.raw`**$\alpha_1$** &amp; \$5.00 and $\beta^2$`, [String.raw`\alpha_1`, String.raw`\beta^2`]],
    ['`$\\alpha$` $HOME ${HOME} $(echo x) $5 and $10', []],
    [String.raw`[x](https://example.com/$HOME) and $\alpha$`, [String.raw`\alpha`]],
    [String.raw`$\left. x \right|$ $\text{x_y^z}$`, [String.raw`\left. x \right|`, String.raw`\text{x_y^z}`]],
    [String.raw`\(\alpha^2\)`, [String.raw`\alpha^2`]],
    [String.raw`Value: <$x$> and <\(\alpha\)>.`, ['x', String.raw`\alpha`]],
    [String.raw`$USD$+$\alpha$`, [String.raw`\alpha`]],
    [String.raw`Costs $5; $\alpha$ and $x^2$.`, [String.raw`\alpha`, 'x^2']],
    [String.raw`$HOME then $\alpha$`, [String.raw`\alpha`]],
    [String.raw`Run echo $$ to print PID. Then $\alpha$`, [String.raw`\alpha`]],
    ['Inline math: $0$; not money: $5 and $10.', ['0']],
  ])('%s', (source, expected) => {
    expect(formulas(source)).toEqual(expected);
  });

  it('takes a display only on lines of its own, in either delimiter', () => {
    expect(formulas('$$\nx^2\n$$\n\n\\[\n\\sum_i x_i\n\\]\n\n$$\\beta$$')).toEqual(['display:x^2', 'display:\\sum_i x_i', 'display:\\beta']);
    expect(formulas('A matrix, $$\\begin{pmatrix} a \\end{pmatrix}$$, inline.')).toEqual([]);
    expect(formulas('$$\nx\n$$ trailing\n$$\n\nAfter $\\alpha$.')).toEqual(['\\alpha']);
    expect(formulas('$$\nx^2\n\n+y^2\n$$')).toEqual(['display:x^2\n\n+y^2']);
  });

  it('finds nothing in code, HTML or links', () => {
    expect(formulas('`$x$` and\n\n```\n$$\ny\n$$\n```\n\n<div>$z$</div>\n\n[$w$](https://example.com)')).toEqual([]);
  });

  it('keeps a display still open at the end pending, unless it is too long', () => {
    expect(findMath('Prose\n\n$$\nx^2\n').pending?.start).toBe(7);
    expect(findMath('```\n$$\n').pending).toBeUndefined();
    expect(findMath('echo $$\n').pending).toBeUndefined();
    expect(findMath(`$$\n${'x'.repeat(5000)}`).pending).toBeUndefined();
  });
});

describe('withMath', () => {
  it('gives remark-math only what is math, in its own forms, and escapes every other dollar', () => {
    expect(withMath(String.raw`Inline \(a^2\) and $b$; it costs $5 and $10, and $HOME is home.`))
      .toBe(String.raw`Inline $$a^2$$ and $$b$$; it costs \$5 and \$10, and \$HOME is home.`);
    expect(withMath('\\[\n\\frac{1}{2}\n\\]\n\nand $$x$$ on its own line:\n\n  $$y$$'))
      .toBe('$$\n\\frac{1}{2}\n$$\n\nand \\$\\$x\\$\\$ on its own line:\n\n  $$\n  y\n  $$');
    expect(withMath('Run echo $$ and `$x$`.')).toBe('Run echo \\$\\$ and `$x$`.');
  });

  it('opens a fence for a display still arriving only while the message streams', () => {
    expect(withMath('Next:\n\n\\[\nx = ', { streaming: true })).toBe('Next:\n\n$$\nx = ');
    expect(withMath('Next:\n\n$$\nx = ')).toBe('Next:\n\n\\$\\$\nx = ');
  });
});
