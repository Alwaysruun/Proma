const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  deg: '\u00b0',
  divide: '\u00f7',
  emsp: '\u2003',
  ensp: '\u2002',
  euro: '\u20ac',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  ndash: '\u2013',
  nbsp: ' ',
  para: '\u00b6',
  permil: '\u2030',
  pound: '\u00a3',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  sect: '\u00a7',
  thinsp: '\u2009',
  times: '\u00d7',
  trade: '\u2122',
  yen: '\u00a5',
}

export function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return match
      }
    })
    .replace(/&#(\d+);/g, (match, code) => {
      try {
        return String.fromCodePoint(Number(code))
      } catch {
        return match
      }
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
      const key = name.toLowerCase()
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match
    })
}

export function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveBingUrl(href) {
  const value = decodeHtmlEntities(href)
  if (!value) return null

  try {
    const parsed = new URL(value, 'https://www.bing.com')
    const encoded = parsed.searchParams.get('u')
    if (encoded && encoded.startsWith('a1')) {
      const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
      if (/^https?:\/\//i.test(decoded)) return decoded
    }
    if (/^https?:\/\//i.test(value)) return value
  } catch {
    return null
  }
  return null
}

export function parseBingResults(html, limit) {
  const blocks = String(html || '').split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1)
  const results = []
  const seen = new Set()

  for (const block of blocks) {
    const heading = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!heading) continue
    const url = resolveBingUrl(heading[1])
    const title = stripHtml(heading[2])
    if (!url || !title || seen.has(url) || /^https?:\/\/(?:www\.)?bing\.com\//i.test(url)) continue

    const snippetMatch = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = stripHtml(snippetMatch ? snippetMatch[1] : '')

    seen.add(url)
    results.push({ title, url, snippet })
    if (results.length >= limit) break
  }

  return results
}

function inlineText(value) {
  return stripHtml(value)
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    || /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  return match ? stripHtml(match[1]) : ''
}

export function htmlToMarkdown(html) {
  const title = extractTitle(html)
  let content = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|template|iframe|form|nav|header|footer|aside|button)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg|canvas|template|iframe|form|nav|header|footer|aside|button)\b[^>]*\/?>/gi, ' ')

  const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(content)
    || /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(content)
  if (main && stripHtml(main[1]).length > 200) content = main[1]

  content = content
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => '\n' + String.fromCharCode(96, 96, 96) + '\n' + decodeHtmlEntities(code.replace(/<[^>]+>/g, '')) + '\n' + String.fromCharCode(96, 96, 96) + '\n')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => '\n' + '#'.repeat(Number(level)) + ' ' + inlineText(text) + '\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => '\n- ' + inlineText(text))
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => '\n> ' + inlineText(text) + '\n')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = inlineText(text)
      return label ? '[' + label + '](' + decodeHtmlEntities(href) + ')' : ''
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')

  content = decodeHtmlEntities(content)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  if (stripHtml(content).length < 80) return stripHtml(html)
  return title && !content.startsWith('# ' + title) ? '# ' + title + '\n\n' + content : content
}
