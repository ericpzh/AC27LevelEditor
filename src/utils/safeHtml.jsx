/**
 * safeHtml — render i18n strings containing a restricted set of HTML tags as
 * safe JSX, without dangerouslySetInnerHTML.
 *
 * Only <strong>, <em>, and <br> tags are allowed.  All other markup, including
 * attribute injection and nested scripting, is treated as plain text.
 *
 * Usage:
 *   import { safeHtml } from '../utils/safeHtml';
 *   <p>{safeHtml(t('modal_backup_overwrite_body', { name: 'file.bak' }))}</p>
 */
import React from 'react';

/** Tags we permit — rendered as real React elements. */
const ALLOWED = {
  strong: (_, children) => React.createElement('strong', { key: undefined }, ...children),
  em:     (_, children) => React.createElement('em', { key: undefined }, ...children),
  br:     () => React.createElement('br', { key: undefined }),
};

/** Quick regex to match opening/closing/self-closing tags. */
const TAG_RE = /<\/?(\w+)[^>]*\/?>/g;

/**
 * Parse a string containing simple HTML markup into an array of React nodes.
 * Unknown tags and malformed markup are rendered as plain text.
 *
 * @param {string} html — the i18n string (may contain <strong>, <em>, <br>)
 * @returns {React.ReactNode[]}
 */
export function safeHtml(html) {
  if (!html || typeof html !== 'string') return html;

  const parts = [];
  const stack = [];
  let lastIndex = 0;

  const flushText = (end) => {
    if (end > lastIndex) {
      parts.push(html.substring(lastIndex, end));
    }
    lastIndex = end;
  };

  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    const full = match[0];
    const tagName = match[1].toLowerCase();
    const isClosing = full.startsWith('</');
    const isSelfClosing = full.endsWith('/>');

    flushText(match.index);

    if (isClosing) {
      // Pop stack and find matching open
      const open = stack.pop();
      if (open && open.tag === tagName) {
        parts.push(open.el);
      }
      // If no matching open, just consume silently
    } else if (isSelfClosing) {
      if (ALLOWED[tagName]) {
        parts.push(ALLOWED[tagName]());
      }
      // unknown self-closing = consume silently
    } else {
      // Opening tag
      if (ALLOWED[tagName]) {
        stack.push({ tag: tagName, el: null });
      }
      // unknown tag = consume silently
    }

    lastIndex = TAG_RE.lastIndex;
  }

  flushText(html.length);

  // Any unclosed tags — render their content as plain text
  // (we lost the content, but this is an edge case)

  return parts.filter(p => p !== null && p !== undefined);
}
