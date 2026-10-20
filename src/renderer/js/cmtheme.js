// Syntax colors shared by Atlas Notepad and the preview pane (colors come from --hl-* CSS variables).
import * as CM from '../vendor/cm.js';

const T = CM.tags;
export const hlStyle = CM.HighlightStyle.define([
  { tag: T.keyword, color: 'var(--hl-kw)' },
  { tag: [T.controlKeyword, T.moduleKeyword, T.operatorKeyword], color: 'var(--hl-kw)' },
  { tag: [T.name, T.deleted, T.character, T.macroName], color: 'var(--hl-name)' },
  { tag: [T.propertyName], color: 'var(--hl-prop)' },
  { tag: [T.function(T.variableName), T.function(T.propertyName), T.labelName], color: 'var(--hl-fn)' },
  { tag: [T.color, T.constant(T.name), T.standard(T.name)], color: 'var(--hl-const)' },
  { tag: [T.definition(T.name), T.separator], color: 'var(--hl-def)' },
  { tag: [T.typeName, T.className, T.changed, T.annotation, T.modifier, T.self, T.namespace], color: 'var(--hl-type)' },
  { tag: [T.number, T.integer, T.float], color: 'var(--hl-num)' },
  { tag: [T.operator, T.url, T.escape, T.regexp, T.special(T.string)], color: 'var(--hl-op)' },
  { tag: [T.meta, T.comment, T.lineComment, T.blockComment, T.docComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: T.strong, fontWeight: 'bold' }, { tag: T.emphasis, fontStyle: 'italic' }, { tag: T.strikethrough, textDecoration: 'line-through' },
  { tag: T.link, color: 'var(--hl-op)', textDecoration: 'underline' },
  { tag: T.heading, fontWeight: 'bold', color: 'var(--hl-heading)' },
  { tag: [T.atom, T.bool, T.special(T.variableName)], color: 'var(--hl-atom)' },
  { tag: [T.processingInstruction, T.string, T.inserted, T.attributeValue], color: 'var(--hl-str)' },
  { tag: [T.tagName], color: 'var(--hl-tag)' }, { tag: [T.attributeName], color: 'var(--hl-attr)' },
  { tag: T.invalid, color: 'var(--hl-invalid)' },
]);

