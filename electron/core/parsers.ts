// Parseurs : chaque format est ramené à une suite de blocs (titres + texte).
import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { marked, type Token } from 'marked';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export type Block = { type: 'heading'; level: number; text: string } | { type: 'text'; text: string };
export interface ParsedDoc { title: string; format: string; blocks: Block[] }

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.md', '.markdown', '.txt', '.html', '.htm'];

const clean = (s: string) => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

export async function parseFile(path: string): Promise<ParsedDoc> {
  const ext = extname(path).toLowerCase();
  const fallbackTitle = basename(path, extname(path));
  const buffer = await readFile(path);
  let doc: ParsedDoc;
  if (ext === '.pdf') doc = await parsePdf(buffer);
  else if (ext === '.docx') doc = await parseDocx(buffer);
  else if (ext === '.md' || ext === '.markdown') doc = parseMarkdown(buffer.toString('utf8'));
  else if (ext === '.html' || ext === '.htm') doc = parseHtml(buffer.toString('utf8'));
  else if (ext === '.txt') doc = parseText(buffer.toString('utf8'));
  else throw new Error(`Format non pris en charge : ${ext}`);
  if (!doc.title) doc.title = fallbackTitle;
  return doc;
}

export function parseMarkdown(source: string): ParsedDoc {
  const blocks: Block[] = [];
  let title = '';
  const text = (t: Token): string => ('tokens' in t && t.tokens ? t.tokens.map(text).join('') : 'text' in t ? String(t.text) : t.raw);
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      const heading = clean(text(token));
      if (!title && token.depth === 1) title = heading;
      blocks.push({ type: 'heading', level: token.depth, text: heading });
    } else if (token.type === 'space' || token.type === 'hr') {
      continue;
    } else if (token.type === 'list') {
      const items = (token.items as Token[]).map((item) => `- ${clean(text(item))}`).join('\n');
      blocks.push({ type: 'text', text: items });
    } else if (token.type === 'code') {
      blocks.push({ type: 'text', text: token.text });
    } else if (token.type === 'table') {
      const rows = [token.header, ...token.rows].map((row: { text: string }[]) => row.map((c) => c.text).join(' | '));
      blocks.push({ type: 'text', text: rows.join('\n') });
    } else {
      const value = clean(text(token));
      if (value) blocks.push({ type: 'text', text: value });
    }
  }
  return { title, format: 'md', blocks };
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)[.)]?\s+\S.{0,90}$/;

export function parseText(source: string): ParsedDoc {
  const blocks: Block[] = [];
  const paragraphs = source.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const single = !paragraph.includes('\n');
    const numbered = single ? NUMBERED_HEADING.exec(paragraph) : null;
    const upper = single && paragraph.length <= 80 && /\p{L}/u.test(paragraph) && paragraph === paragraph.toUpperCase() && !/[.!?]$/.test(paragraph);
    if (numbered && !/[.!?:;,]$/.test(paragraph)) {
      blocks.push({ type: 'heading', level: numbered[1].split('.').length, text: paragraph });
    } else if (upper) {
      blocks.push({ type: 'heading', level: 1, text: paragraph });
    } else {
      blocks.push({ type: 'text', text: clean(paragraph) });
    }
  }
  return { title: '', format: 'txt', blocks };
}

/** Convertit un fragment DOM en blocs. */
function domToBlocks(root: Element): Block[] {
  const blocks: Block[] = [];
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const value = clean(child.textContent ?? '');
        if (value) blocks.push({ type: 'heading', level: Number(tag[1]), text: value });
      } else if (tag === 'p' || tag === 'pre' || tag === 'blockquote' || tag === 'dd' || tag === 'dt') {
        const value = clean(child.textContent ?? '');
        if (value) blocks.push({ type: 'text', text: value });
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(child.querySelectorAll('li')).map((li) => `- ${clean(li.textContent ?? '')}`).filter((i) => i.length > 2);
        if (items.length) blocks.push({ type: 'text', text: items.join('\n') });
      } else if (tag === 'table') {
        const rows = Array.from(child.querySelectorAll('tr'))
          .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => clean(c.textContent ?? '')).join(' | '))
          .filter(Boolean);
        if (rows.length) blocks.push({ type: 'text', text: rows.join('\n') });
      } else if (['script', 'style', 'nav', 'footer', 'noscript', 'svg', 'form', 'iframe'].includes(tag)) {
        continue;
      } else if (child.children.length) {
        walk(child);
      } else {
        const value = clean(child.textContent ?? '');
        if (value) blocks.push({ type: 'text', text: value });
      }
    }
  };
  walk(root);
  return blocks;
}

export function parseHtml(source: string, opts: { article?: boolean } = {}): ParsedDoc {
  const wrapped = /<html[\s>]/i.test(source) ? source : `<!doctype html><html><head></head><body>${source}</body></html>`;
  const { document } = parseHTML(wrapped);
  let title = clean(document.querySelector('title')?.textContent ?? '');
  let root: Element | null = document.body as unknown as Element;
  if (opts.article !== false) {
    try {
      const { document: copy } = parseHTML(wrapped);
      const article = new Readability(copy as unknown as Document, { charThreshold: 200 }).parse();
      if (article?.content && (article.textContent ?? '').trim().length > 200) {
        const { document: articleDoc } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
        root = articleDoc.body as unknown as Element;
        if (article.title) title = clean(article.title);
      }
    } catch {
      // Readability a échoué : on garde le corps complet.
    }
  }
  const blocks = root ? domToBlocks(root) : [];
  if (!title) {
    const h1 = blocks.find((b) => b.type === 'heading');
    if (h1) title = h1.text;
  }
  return { title, format: 'html', blocks };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDoc> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml({ buffer });
  const doc = parseHtml(value, { article: false });
  const first = doc.blocks.find((b) => b.type === 'heading' && b.level === 1);
  return { title: first?.text ?? '', format: 'docx', blocks: doc.blocks };
}

interface PdfLine { text: string; size: number; bold: boolean }

async function parsePdf(buffer: Buffer): Promise<ParsedDoc> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise;
  const lines: PdfLine[] = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    let current: { y: number; parts: string[]; size: number; bold: boolean } | null = null;
    const flush = () => {
      if (current) {
        const text = clean(current.parts.join(''));
        if (text) lines.push({ text, size: current.size, bold: current.bold });
      }
      current = null;
    };
    for (const raw of content.items) {
      const item = raw as { str?: string; transform?: number[]; height?: number; hasEOL?: boolean; fontName?: string };
      if (item.str === undefined || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const size = Math.round((item.height || Math.abs(item.transform[3])) * 10) / 10;
      const bold = /bold|black|heavy/i.test(String((content.styles as Record<string, { fontFamily?: string }>)[item.fontName ?? '']?.fontFamily ?? item.fontName ?? ''));
      if (!current || Math.abs(current.y - y) > 2) {
        flush();
        current = { y, parts: [], size, bold };
      }
      current.parts.push(item.str);
      if (size > current.size && item.str.trim()) current.size = size;
      if (item.hasEOL) current.parts.push(' ');
    }
    flush();
    lines.push({ text: '', size: 0, bold: false }); // saut de page = fin de paragraphe
  }
  const meta = await pdf.getMetadata().catch(() => null);
  const metaTitle = clean(String((meta?.info as { Title?: string } | undefined)?.Title ?? ''));
  await pdf.loadingTask.destroy();
  const blocks = pdfLinesToBlocks(lines);
  const firstHeading = blocks.find((b) => b.type === 'heading' && b.level === 1);
  return { title: metaTitle || firstHeading?.text || '', format: 'pdf', blocks };
}

/** Détecte les titres d'un PDF par la taille de police, relativement au corps de texte. */
export function pdfLinesToBlocks(lines: PdfLine[]): Block[] {
  const weight = new Map<number, number>();
  for (const line of lines) if (line.text) weight.set(line.size, (weight.get(line.size) ?? 0) + line.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const headingSizes = [...weight.keys()].filter((s) => s >= body * 1.12).sort((a, b) => b - a).slice(0, 4);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'text', text: paragraph.join(' ').replace(/(\p{L})- (\p{Ll})/gu, '$1$2') });
    paragraph = [];
  };
  for (const line of lines) {
    if (!line.text) { flush(); continue; }
    const level = headingSizes.indexOf(line.size);
    const short = line.text.length <= 120;
    const numbered = line.bold && short && NUMBERED_HEADING.test(line.text) && !/[.!?;,]$/.test(line.text);
    if (short && level >= 0) {
      flush();
      blocks.push({ type: 'heading', level: level + 1, text: line.text });
    } else if (numbered) {
      flush();
      blocks.push({ type: 'heading', level: Math.min(4, line.text.split(/\s/)[0].split('.').filter(Boolean).length), text: line.text });
    } else {
      paragraph.push(line.text);
      if (/[.!?:]$/.test(line.text) && line.text.length < 60) flush();
    }
  }
  flush();
  return blocks;
}
