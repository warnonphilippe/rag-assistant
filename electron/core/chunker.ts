// Découpage : hiérarchique d'après les titres, avec repli sémantique quand la structure est insuffisante.
import { createHash } from 'node:crypto';
import type { Block, ParsedDoc } from './parsers.js';
import type { ChunkingMode } from '../../shared/types.js';

export interface SectionNode {
  key: number;             // identifiant local (index)
  parentKey: number | null;
  topKey: number;          // section de premier niveau à laquelle elle appartient
  level: number;
  title: string;
  path: string;            // fil d'Ariane
  synthetic: boolean;      // pseudo-section issue du découpage sémantique
}

export interface Chunk {
  sectionKey: number;
  ord: number;
  text: string;
  sha: string;
}

export interface ChunkedDoc { sections: SectionNode[]; chunks: Chunk[]; mode: ChunkingMode }

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;
export type TitleFn = (text: string) => Promise<string>;

export const LEAF_CHARS = 1400;          // ≈ 350 tokens
export const BIG_SECTION_CHARS = 6000;   // ≈ 1500 tokens : au-delà, la section est redécoupée sémantiquement
const MIN_GROUP_CHARS = 500;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function meanVector(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]?.length ?? 0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function splitSentences(text: string): string[] {
  const parts = text.replace(/\n+/g, ' \n ').split(/(?<=[.!?…])\s+(?=[\p{Lu}\d«"(-])|\s\n\s/u);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Regroupe des morceaux de texte en feuilles d'environ LEAF_CHARS caractères. */
export function packLeaves(pieces: string[], limit = LEAF_CHARS): string[] {
  const units: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= limit) { units.push(piece); continue; }
    let buffer = '';
    for (const sentence of splitSentences(piece)) {
      if (sentence.length > limit) {
        if (buffer) { units.push(buffer); buffer = ''; }
        for (let i = 0; i < sentence.length; i += limit) units.push(sentence.slice(i, i + limit));
      } else if (buffer.length + sentence.length + 1 > limit) {
        units.push(buffer); buffer = sentence;
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
      }
    }
    if (buffer) units.push(buffer);
  }
  const leaves: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > limit) { leaves.push(current); current = unit; }
    else current = current ? `${current}\n${unit}` : unit;
  }
  if (current) leaves.push(current);
  // Une dernière feuille trop courte est rattachée à la précédente.
  if (leaves.length > 1 && leaves[leaves.length - 1].length < 200) {
    const tail = leaves.pop()!;
    leaves[leaves.length - 1] += `\n${tail}`;
  }
  return leaves;
}

/**
 * Découpage sémantique : coupe là où la similarité entre phrases voisines chute.
 * Retourne des groupes de phrases cohérents.
 */
export async function semanticGroups(text: string, embed: EmbedFn): Promise<string[]> {
  const sentences = splitSentences(text);
  if (sentences.length < 6) return [text];
  // Fenêtre glissante de 2 phrases pour lisser le signal.
  const windows = sentences.map((s, i) => (i + 1 < sentences.length ? `${s} ${sentences[i + 1]}` : s));
  const vectors = await embed(windows);
  const distances: number[] = [];
  for (let i = 0; i + 1 < vectors.length; i++) distances.push(1 - cosine(vectors[i], vectors[i + 1]));
  const sorted = [...distances].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.85)] ?? 1;
  const groups: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (let i = 0; i < sentences.length; i++) {
    current.push(sentences[i]);
    size += sentences[i].length + 1;
    const isBreak = i < distances.length && distances[i] >= threshold && distances[i] > 0.05;
    if ((isBreak && size >= MIN_GROUP_CHARS) || size >= BIG_SECTION_CHARS) {
      groups.push(current.join(' '));
      current = [];
      size = 0;
    }
  }
  if (current.length) {
    if (groups.length && size < MIN_GROUP_CHARS / 2) groups[groups.length - 1] += ` ${current.join(' ')}`;
    else groups.push(current.join(' '));
  }
  return groups;
}

const fallbackTitle = (text: string) => {
  const first = splitSentences(text)[0] ?? text;
  return first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first.replace(/[.:;]$/, '');
};

/** Structure brute issue des titres : sections avec leur texte propre. */
function outline(doc: ParsedDoc): { nodes: SectionNode[]; texts: string[][] } {
  const nodes: SectionNode[] = [];
  const texts: string[][] = [];
  const stack: SectionNode[] = [];
  const add = (level: number, title: string): SectionNode => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const key = nodes.length;
    const node: SectionNode = {
      key, parentKey: parent?.key ?? null, topKey: parent?.topKey ?? key, level, title,
      path: parent ? `${parent.path} > ${title}` : title, synthetic: false,
    };
    nodes.push(node); texts.push([]); stack.push(node);
    return node;
  };
  let seenTitle = false;
  for (const block of doc.blocks as Block[]) {
    if (block.type === 'heading') {
      // Le premier H1 identique au titre du document n'est pas une section.
      if (!seenTitle && block.level === 1 && normalize(block.text) === normalize(doc.title)) { seenTitle = true; continue; }
      add(block.level, block.text);
    } else {
      if (!stack.length) add(1, nodes.length ? 'Suite' : 'Introduction');
      texts[stack[stack.length - 1].key].push(block.text);
    }
  }
  return { nodes, texts };
}

/**
 * Découpe un document en sections et feuilles.
 * - structure suffisante  -> hiérarchique ;
 * - sections trop longues -> redécoupage sémantique de ces sections (mixte) ;
 * - pas de structure      -> entièrement sémantique.
 */
export async function chunkDocument(doc: ParsedDoc, embed: EmbedFn, titleFor?: TitleFn): Promise<ChunkedDoc> {
  const { nodes, texts } = outline(doc);
  const realHeadings = doc.blocks.filter((b) => b.type === 'heading').length;
  const totalChars = texts.reduce((sum, t) => sum + t.join('\n').length, 0);
  const structured = realHeadings >= 2 && totalChars / Math.max(1, realHeadings) <= BIG_SECTION_CHARS * 1.5;

  const sections: SectionNode[] = [];
  const chunks: Chunk[] = [];
  let usedSemantic = false;
  let usedHierarchy = false;
  let titled = 0;

  const pushSection = (node: Omit<SectionNode, 'key'>): SectionNode => {
    const created = { ...node, key: sections.length };
    sections.push(created);
    return created;
  };
  const pushLeaves = (section: SectionNode, pieces: string[]) => {
    for (const leaf of packLeaves(pieces)) {
      chunks.push({ sectionKey: section.key, ord: chunks.length, text: leaf, sha: sha256(normalize(leaf)) });
    }
  };
  const makeTitle = async (text: string) => {
    if (titleFor && titled < 12) {
      titled++;
      try {
        const title = (await titleFor(text.slice(0, 1500))).replace(/^["«\s]+|["»\s.]+$/g, '').split('\n')[0];
        if (title && title.length <= 90) return title;
      } catch { /* repli ci-dessous */ }
    }
    return fallbackTitle(text);
  };

  if (!structured) {
    // Document peu ou pas structuré : tout le texte passe par le découpage sémantique.
    usedSemantic = true;
    const full = doc.blocks.map((b) => b.text).join('\n');
    for (const group of await semanticGroups(full, embed)) {
      const title = await makeTitle(group);
      const section = pushSection({ parentKey: null, topKey: sections.length, level: 1, title, path: title, synthetic: true });
      pushLeaves(section, [group]);
    }
  } else {
    const keyMap = new Map<number, number>();
    for (const node of nodes) {
      const parentKey = node.parentKey === null ? null : keyMap.get(node.parentKey)!;
      const topKey = node.topKey === node.key ? sections.length : keyMap.get(node.topKey)!;
      const section = pushSection({ ...node, parentKey, topKey });
      keyMap.set(node.key, section.key);
      const own = texts[node.key];
      const length = own.join('\n').length;
      if (!length) continue;
      if (length > BIG_SECTION_CHARS) {
        usedSemantic = true;
        const groups = await semanticGroups(own.join('\n'), embed);
        for (const group of groups) {
          const title = groups.length > 1 ? await makeTitle(group) : node.title;
          const sub = groups.length > 1
            ? pushSection({ parentKey: section.key, topKey: section.topKey, level: node.level + 1, title, path: `${node.path} > ${title}`, synthetic: true })
            : section;
          pushLeaves(sub, [group]);
        }
      } else {
        usedHierarchy = true;
        pushLeaves(section, own);
      }
    }
  }
  const mode: ChunkingMode = usedSemantic && usedHierarchy ? 'mixed' : usedSemantic ? 'semantic' : 'hierarchical';
  return { sections, chunks, mode };
}

/** Texte réellement vectorisé : le fil d'Ariane situe la feuille dans le document. */
export const embeddingText = (docTitle: string, sectionPath: string, text: string) => `${docTitle} > ${sectionPath}\n${text}`;
