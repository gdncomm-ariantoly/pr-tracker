/**
 * Show GitHub's own rendering of a comment (`bodyHTML`) safely.
 *
 * GitHub already sanitizes it, but this page never trusts remote HTML: it is
 * parsed inert (DOMParser, no scripts run, nothing loads), then rebuilt from an
 * allowlist of tags and attributes. Anything else is dropped — its text kept.
 */

const TAGS = new Set([
  'a', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'ins', 'mark',
  'code', 'pre', 'kbd', 'samp', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'img', 'span', 'div', 'details', 'summary', 'sup', 'sub', 'input', 'g-emoji', 'picture', 'source',
])
/** Dropped with their content (not just unwrapped). */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'svg', 'math', 'template', 'noscript', 'link', 'meta'])
const ATTRS = new Set(['href', 'src', 'srcset', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align', 'width', 'height', 'open', 'checked', 'disabled', 'type', 'start', 'lang', 'alias', 'fallback-src'])
const GITHUB = 'https://github.com/'

/** @param {string} value @param {'href' | 'src'} kind */
function safeUrl(value, kind) {
  try {
    const url = new URL(value, GITHUB) // GitHub emits relative links: /org/repo/…
    if (url.protocol === 'https:' || (kind === 'href' && (url.protocol === 'http:' || url.protocol === 'mailto:'))) return url.href
  } catch {
    // unparseable → dropped
  }
  return null
}

/**
 * @param {Node} node
 * @param {Document} doc  the page's document — output nodes are created here
 * @returns {Node | null}
 */
function clean(node, doc) {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = /** @type {Element} */ (node)
  const tag = el.tagName.toLowerCase()
  if (DROP.has(tag)) return null
  const kids = () => [...el.childNodes].map((c) => clean(c, doc)).filter((c) => c !== null)
  if (!TAGS.has(tag)) {
    const frag = doc.createDocumentFragment()
    frag.append(...kids())
    return frag
  }
  if (tag === 'input' && el.getAttribute('type') !== 'checkbox') return null // task-list boxes only
  const out = doc.createElement(tag)
  for (const { name, value } of [...el.attributes]) {
    const attr = name.toLowerCase()
    if (!ATTRS.has(attr)) continue
    if (attr === 'href' || attr === 'src') {
      const url = safeUrl(value, attr)
      if (url) out.setAttribute(attr, url)
    } else if (attr === 'srcset') {
      const parts = value.split(',').map((p) => p.trim().split(/\s+/)).map(([u, d]) => [safeUrl(u, 'src'), d]).filter(([u]) => u)
      if (parts.length) out.setAttribute('srcset', parts.map((p) => p.join(' ')).join(', '))
    } else {
      out.setAttribute(attr, value)
    }
  }
  if (tag === 'a') {
    out.setAttribute('target', '_blank')
    out.setAttribute('rel', 'noopener noreferrer')
  }
  if (tag === 'img') out.setAttribute('loading', 'lazy')
  if (tag === 'input') out.setAttribute('disabled', '')
  out.append(...kids())
  return out
}

/**
 * @param {string | undefined} html  GitHub's bodyHTML
 * @param {string} fallback  the raw markdown, shown as plain text if there's no HTML
 * @returns {DocumentFragment}
 */
export function renderComment(html, fallback) {
  const frag = document.createDocumentFragment()
  if (!html) {
    const p = document.createElement('p')
    p.textContent = fallback || '(no text)'
    frag.append(p)
    return frag
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const child of [...parsed.body.childNodes]) {
    const safe = clean(child, document)
    if (safe) frag.append(safe)
  }
  return frag
}
