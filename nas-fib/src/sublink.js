import { extractSubscriptionLinks } from './fib.js';
import { solveChallenge } from './pow.js';
import { recordEvent } from './event-log.js';

export async function resolveSubscription({ html, fib, cookie, fetchImpl, issueState, eventLog,
  now = () => new Date(), solve = solveChallenge }) {
  // Old installations have no issue widget and retain their original flow.
  if (!/sublink-(?:box|issue|copy|import)/i.test(html)) return extractSubscriptionLinks(html);
  async function json(path, body) {
    const response = await fetchImpl(`${fib.baseUrl}/user/sublink/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, accept: 'application/json', referer: `${fib.baseUrl}/user`,
        'x-requested-with': 'XMLHttpRequest',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
      ...(body ? { body: new URLSearchParams(body) } : {})
    });
    if (!response.ok) throw new Error(`FIB sublink ${path} HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`FIB sublink ${path} returned non-JSON (session may have expired)`); }
    if (payload?.ret !== 1) {
      const message = String(payload?.msg ?? '');
      const reason = /间隔|频繁|稍后|冷却|秒/.test(message) ? 'cooldown' :
        /次数|上限|额度/.test(message) ? 'quota exhausted' : 'request rejected';
      throw new Error(`FIB sublink ${path}: ${reason}`);
    }
    return payload;
  }
  function parseBox(payload) {
    if (typeof payload.fp !== 'string' || typeof payload.box !== 'string') throw new Error('FIB sublink box response invalid');
    try { return extractSubscriptionLinks(payload.box); }
    catch (error) {
      if (error.name !== 'SubscriptionLinkMissingError') throw error;
      // A nonempty fingerprint without a recognized Clash link is a parser error, not permission to issue again.
      if (payload.fp) throw error;
      return null;
    }
  }
  let box = await json('box');
  let links = parseBox(box);
  if (links) return links;
  const issueButton = box.box.match(/<button\b[^>]*\bid\s*=\s*['"]sublink-issue['"][^>]*>/i)?.[0];
  if (!issueButton || /\sdisabled(?:\s|=|>)/i.test(issueButton)) throw new Error('FIB subscription issuance unavailable (quota or cooldown)');
  if (!issueState) throw new Error('FIB persistent issue state is required');
  await issueState.reserve(now());
  await recordEvent(eventLog, 'fib_issue_started', {});
  const challenge = await json('challenge');
  const nonce = await solve(challenge.challenge);
  // Never automatically repeat a POST: a lost response may still mean the link was issued.
  await json('issue', { challenge: challenge.challenge, nonce });
  await recordEvent(eventLog, 'fib_issue_succeeded', {});
  box = await json('box');
  links = parseBox(box);
  if (!links) throw new Error('FIB issue succeeded but no Clash subscription is available');
  return links;
}
