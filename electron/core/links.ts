// Liens : récupération en lecture seule (GET), connecteur Confluence facultatif, détection de changement.
import { assertAllowedUrl } from './guardrails.js';
import { normalize, sha256 } from './chunker.js';
import { parseHtml, parseMarkdown, parseText, type ParsedDoc } from './parsers.js';

export interface ConfluenceAccess { baseUrl: string; user: string; token: string }

export interface FetchedLink {
  notModified: boolean;
  parsed: ParsedDoc | null;
  sha: string | null;
  etag: string | null;
  lastModified: string | null;
  remoteVersion: string | null;
}

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

async function safeFetch(rawUrl: string, headers: Record<string, string>): Promise<Response> {
  let url = assertAllowedUrl(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'AssistantRAG/0.1 (lecture seule)', accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5', ...headers },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = assertAllowedUrl(new URL(response.headers.get('location')!, url).toString());
      // Les en-têtes d'authentification ne suivent pas une redirection vers un autre hôte.
      if (next.host !== url.host) delete headers['authorization'];
      url = next;
      continue;
    }
    return response;
  }
  throw new Error('Trop de redirections');
}

async function readBody(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error('Page trop volumineuse');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new Error('Page trop volumineuse');
  return buffer;
}

export const contentSha = (doc: ParsedDoc) => sha256(normalize(doc.blocks.map((b) => b.text).join('\n')));

/** Extrait l'identifiant de page d'une URL Confluence appartenant au site configuré. */
export function confluencePageId(url: string, access: ConfluenceAccess | null): string | null {
  if (!access?.baseUrl || !access.token) return null;
  try {
    const target = new URL(url);
    if (target.host !== new URL(access.baseUrl).host) return null;
    return /\/pages\/(\d+)/.exec(target.pathname)?.[1] ?? target.searchParams.get('pageId');
  } catch {
    return null;
  }
}

async function fetchConfluence(pageId: string, access: ConfluenceAccess, knownVersion: string | null): Promise<FetchedLink> {
  const base = new URL(access.baseUrl);
  const wiki = base.pathname.replace(/\/$/, '').endsWith('/wiki') || base.host.endsWith('.atlassian.net') ? '/wiki' : base.pathname.replace(/\/$/, '');
  const api = `${base.origin}${wiki}/rest/api/content/${pageId}?expand=body.view,version`;
  const response = await safeFetch(api, {
    authorization: `Basic ${Buffer.from(`${access.user}:${access.token}`).toString('base64')}`,
    accept: 'application/json',
  });
  if (!response.ok) throw new Error(`Confluence a répondu ${response.status}`);
  const page = JSON.parse((await readBody(response)).toString('utf8')) as { title?: string; version?: { number?: number }; body?: { view?: { value?: string } } };
  const remoteVersion = page.version?.number ? String(page.version.number) : null;
  if (knownVersion && remoteVersion === knownVersion) return { notModified: true, parsed: null, sha: null, etag: null, lastModified: null, remoteVersion };
  const parsed = parseHtml(page.body?.view?.value ?? '', { article: false });
  parsed.title = page.title ?? parsed.title;
  return { notModified: false, parsed, sha: contentSha(parsed), etag: null, lastModified: null, remoteVersion };
}

export interface Conditional { etag: string | null; lastModified: string | null; remoteVersion: string | null }

/** Récupère et analyse une page. Avec `known`, la requête est conditionnelle (304 = inchangé). */
export async function fetchLink(url: string, access: ConfluenceAccess | null, known?: Conditional): Promise<FetchedLink> {
  const pageId = confluencePageId(url, access);
  if (pageId && access) return fetchConfluence(pageId, access, known?.remoteVersion ?? null);

  const headers: Record<string, string> = {};
  if (known?.etag) headers['if-none-match'] = known.etag;
  if (known?.lastModified) headers['if-modified-since'] = known.lastModified;
  const response = await safeFetch(url, headers);
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (response.status === 304) return { notModified: true, parsed: null, sha: null, etag, lastModified, remoteVersion: null };
  if (response.status === 401 || response.status === 403) throw new Error('Page protégée : accès refusé');
  if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}`);
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  const body = (await readBody(response)).toString('utf8');
  let parsed: ParsedDoc;
  if (type.includes('markdown') || /\.(md|markdown)$/i.test(new URL(url).pathname)) parsed = parseMarkdown(body);
  else if (type.includes('text/plain')) parsed = parseText(body);
  else if (type.includes('html') || /^\s*<(!doctype|html)/i.test(body)) parsed = parseHtml(body);
  else throw new Error(`Type de contenu non pris en charge : ${type || 'inconnu'}`);
  if (!parsed.title) parsed.title = new URL(url).hostname + new URL(url).pathname;
  if (!parsed.blocks.length) throw new Error('Aucun texte exploitable sur cette page');
  return { notModified: false, parsed, sha: contentSha(parsed), etag, lastModified, remoteVersion: null };
}
