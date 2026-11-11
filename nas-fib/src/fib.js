function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readAttribute(attrs, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i');
  const match = attrs.match(pattern);
  return match ? decodeHtmlEntities(match[2]) : null;
}

export function extractSubscriptionLinks(html) {
  const links = {};
  const buttonPattern = /<(?:button|a)\b([^>]*?)>([\s\S]*?)<\/(?:button|a)>/gi;
  let match;

  while ((match = buttonPattern.exec(html)) !== null) {
    const attrs = match[1];
    const text = `${readAttribute(attrs, 'data-import') ?? ''} ${stripTags(match[2])}`;
    const link = readAttribute(attrs, 'data-url') ?? readAttribute(attrs, 'data-clipboard-text');
    if (!link) continue;
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;

    if (/clash/i.test(text)) links.clash = link;
    if (/v2rayn/i.test(text)) links.v2rayn = link;
    if (/shadowrocket/i.test(text)) links.shadowrocket = link;
  }

  if (!links.clash) {
    const error = new Error('Clash subscription link not found in FIB user page');
    error.name = 'SubscriptionLinkMissingError';
    throw error;
  }

  return links;
}

export function normalizeFibConfig(config) {
  const baseUrl = String(config.baseUrl ?? 'https://1.fibacc.net').replace(/\/+$/, '');
  const email = String(config.email ?? '').trim();
  const password = String(config.password ?? '');

  if (!email) throw new Error('FIB email is required');
  if (!password) throw new Error('FIB password is required');

  return { baseUrl, email, password };
}

export function loginUrl(fib) {
  return `${fib.baseUrl}/auth/login`;
}

export function checkinUrl(fib) {
  return `${fib.baseUrl}/user/checkin`;
}
