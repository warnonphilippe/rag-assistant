// Détection de nouvelles versions / doublons proches à partir des vecteurs, et application de la décision.
import { cosine, meanVector } from './chunker.js';
import { now, type Store } from './db.js';
import type { MergeChoices, PendingVersion, SectionComparison, VersionAction, VersionVerdict } from '../../shared/types.js';

/** Deux feuilles sont considérées équivalentes au-delà de ce cosinus. */
export const CHUNK_MATCH = 0.85;
/** Une couverture au-delà de ce seuil signifie « presque entièrement retrouvé ». */
export const HIGH_COVERAGE = 0.7;
/** En dessous de ce seuil dans les deux sens, les documents sont jugés distincts. */
export const MIN_COVERAGE = 0.5;
/** Présélection : cosinus minimal entre vecteurs « document ». */
export const DOC_CANDIDATE = 0.75;
const SECTION_MATCH = 0.75;

export interface VecChunk { sha: string; vec: Float32Array }

/** Part des feuilles de `a` qui ont un équivalent dans `b` (hash identique ou vecteur proche). */
export function coverage(a: VecChunk[], b: VecChunk[], threshold = CHUNK_MATCH): number {
  if (!a.length) return 0;
  const shas = new Set(b.map((c) => c.sha));
  let covered = 0;
  for (const chunk of a) {
    if (shas.has(chunk.sha)) { covered++; continue; }
    for (const other of b) {
      if (cosine(chunk.vec, other.vec) >= threshold) { covered++; break; }
    }
  }
  return covered / a.length;
}

export function classify(coverageOld: number, coverageNew: number): VersionVerdict | null {
  if (coverageOld < MIN_COVERAGE && coverageNew < MIN_COVERAGE) return null;
  if (coverageOld >= HIGH_COVERAGE && coverageNew >= HIGH_COVERAGE) return 'revision';
  if (coverageOld >= HIGH_COVERAGE) return 'superset';
  if (coverageNew >= HIGH_COVERAGE) return 'subset';
  return 'overlap';
}

/** Titre normalisé : sans extension, numéro de version, date ni mention « final / révision / copie ». */
export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\.(pdf|docx|md|markdown|txt|html?)$/i, '')
    .replace(/\(\d+\)/g, ' ')
    .replace(/[_\s]+/g, ' ')
    .replace(/\b\d{4}[-_.]?\d{2}[-_.]?\d{2}\b|\b\d{2}[-_.]\d{2}[-_.]\d{4}\b/g, ' ')
    .replace(/\b(v|version|rev|revision)[\s._-]*\d+(\.\d+)*\b/g, ' ')
    .replace(/\b(final|finale|definitif|draft|brouillon|copie|copy|nouveau|new|revise|revisee|revision|maj|updated?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface TopSection { id: number; title: string; shas: string[]; vec: Float32Array }

/** Compare les sections de premier niveau de deux documents. */
export function compareSections(oldSections: TopSection[], newSections: TopSection[]): SectionComparison[] {
  const result: SectionComparison[] = [];
  const used = new Set<number>();
  const key = (s: TopSection) => s.shas.join('|');
  for (const section of newSections) {
    let best: TopSection | null = null;
    let bestScore = 0;
    for (const old of oldSections) {
      if (used.has(old.id)) continue;
      const score = key(old) === key(section) ? 2 : Math.max(cosine(old.vec, section.vec), normTitle(old.title) === normTitle(section.title) ? SECTION_MATCH : 0);
      if (score > bestScore) { best = old; bestScore = score; }
    }
    if (best && bestScore >= SECTION_MATCH) {
      used.add(best.id);
      result.push({ title: section.title, diff: bestScore === 2 ? 'unchanged' : 'modified', newSectionId: section.id, oldSectionId: best.id });
    } else {
      result.push({ title: section.title, diff: 'added', newSectionId: section.id, oldSectionId: null });
    }
  }
  for (const old of oldSections) {
    if (!used.has(old.id)) result.push({ title: old.title, diff: 'removed', newSectionId: null, oldSectionId: old.id });
  }
  return result;
}

function topSections(store: Store, docId: number): TopSection[] {
  const sections = store.all<{ id: number; title: string }>('SELECT id, title FROM sections WHERE doc_id = ? AND top_id = id ORDER BY ord', docId);
  const out: TopSection[] = [];
  for (const section of sections) {
    const chunks = store.all<{ sha: string; vec: Uint8Array }>(
      'SELECT c.sha AS sha, c.vec AS vec FROM chunks c JOIN sections s ON s.id = c.section_id WHERE s.top_id = ? ORDER BY c.ord', section.id,
    );
    if (!chunks.length) continue;
    const vectors = chunks.map((c) => new Float32Array(c.vec.buffer.slice(c.vec.byteOffset, c.vec.byteOffset + c.vec.byteLength)));
    out.push({ id: section.id, title: section.title, shas: chunks.map((c) => c.sha), vec: meanVector(vectors) });
  }
  return out;
}

interface Report { coverageOld: number; coverageNew: number; verdict: VersionVerdict; sections: SectionComparison[] }

/**
 * Cherche, parmi les documents actifs, celui dont le nouveau document serait une version.
 * Retourne true si une décision de l'utilisateur est requise.
 */
export function detectVersion(store: Store, newDocId: number): boolean {
  const fresh = store.get<{ norm_title: string; doc_vec: Uint8Array | null }>('SELECT norm_title, doc_vec FROM documents WHERE id = ?', newDocId);
  if (!fresh?.doc_vec) return false;
  const freshVec = new Float32Array(fresh.doc_vec.buffer.slice(fresh.doc_vec.byteOffset, fresh.doc_vec.byteOffset + fresh.doc_vec.byteLength));
  const others = store.all<{ id: number; norm_title: string; doc_vec: Uint8Array | null }>(
    "SELECT id, norm_title, doc_vec FROM documents WHERE status = 'ready' AND kind = 'file' AND id != ?", newDocId,
  );
  const newChunks = store.docVectors(newDocId);
  let best: { oldId: number; report: Report; score: number } | null = null;
  for (const other of others) {
    if (!other.doc_vec) continue;
    const vec = new Float32Array(other.doc_vec.buffer.slice(other.doc_vec.byteOffset, other.doc_vec.byteOffset + other.doc_vec.byteLength));
    const sameTitle = !!fresh.norm_title && fresh.norm_title === other.norm_title;
    if (!sameTitle && cosine(freshVec, vec) < DOC_CANDIDATE) continue;
    const oldChunks = store.docVectors(other.id);
    const coverageOld = coverage(oldChunks, newChunks);
    const coverageNew = coverage(newChunks, oldChunks);
    const verdict = classify(coverageOld, coverageNew);
    if (!verdict) continue;
    const score = coverageOld + coverageNew;
    if (!best || score > best.score) {
      best = { oldId: other.id, score, report: { coverageOld, coverageNew, verdict, sections: compareSections(topSections(store, other.id), topSections(store, newDocId)) } };
    }
  }
  if (!best) return false;
  store.run('INSERT INTO pending_versions(new_doc_id, old_doc_id, report) VALUES(?, ?, ?)', newDocId, best.oldId, JSON.stringify(best.report));
  return true;
}

export function listPending(store: Store): PendingVersion[] {
  const rows = store.all<{ id: number; new_doc_id: number; old_doc_id: number; report: string }>('SELECT * FROM pending_versions ORDER BY id');
  const doc = (id: number) => store.get<{ id: number; title: string; format: string; indexed_at: string | null }>('SELECT id, title, format, indexed_at FROM documents WHERE id = ?', id);
  const count = (id: number) => store.get<{ n: number }>('SELECT COUNT(*) AS n FROM sections WHERE doc_id = ? AND top_id = id', id)?.n ?? 0;
  const out: PendingVersion[] = [];
  for (const row of rows) {
    const fresh = doc(row.new_doc_id);
    const old = doc(row.old_doc_id);
    if (!fresh || !old) continue;
    const report = JSON.parse(row.report) as Report;
    out.push({
      id: row.id,
      newDoc: { id: fresh.id, title: fresh.title, format: fresh.format, sections: count(fresh.id) },
      oldDoc: { id: old.id, title: old.title, format: old.format, sections: count(old.id), indexedAt: old.indexed_at },
      ...report,
    });
  }
  return out;
}

/** Copie une section de premier niveau (et ses sous-sections, feuilles comprises) vers un autre document. */
function copySection(store: Store, topId: number, targetDocId: number, ord: number) {
  const sections = store.all<{ id: number; parent_id: number | null; level: number; title: string; path: string; synthetic: number }>(
    'SELECT id, parent_id, level, title, path, synthetic FROM sections WHERE top_id = ? ORDER BY ord', topId,
  );
  const map = new Map<number, number>();
  let newTop = 0;
  sections.forEach((section, index) => {
    const id = store.insert(
      'INSERT INTO sections(doc_id, parent_id, top_id, level, title, path, ord, synthetic) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      targetDocId, section.parent_id === null ? null : map.get(section.parent_id) ?? null, newTop || null, section.level, section.title, section.path, ord + index / 1000, section.synthetic,
    );
    if (!newTop) { newTop = id; store.run('UPDATE sections SET top_id = ? WHERE id = ?', id, id); }
    map.set(section.id, id);
  });
  const chunks = store.all<{ section_id: number; ord: number; text: string; sha: string; vec: Uint8Array }>(
    'SELECT c.section_id, c.ord, c.text, c.sha, c.vec FROM chunks c JOIN sections s ON s.id = c.section_id WHERE s.top_id = ? ORDER BY c.ord', topId,
  );
  for (const chunk of chunks) {
    const id = store.insert('INSERT INTO chunks(doc_id, section_id, ord, text, sha, vec) VALUES(?, ?, ?, ?, ?, ?)', targetDocId, map.get(chunk.section_id)!, chunk.ord, chunk.text, chunk.sha, chunk.vec);
    store.run('INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)', id, chunk.text);
  }
}

function dropSection(store: Store, topId: number) {
  store.run('DELETE FROM chunks_fts WHERE rowid IN (SELECT c.id FROM chunks c JOIN sections s ON s.id = c.section_id WHERE s.top_id = ?)', topId);
  store.run('DELETE FROM chunks WHERE section_id IN (SELECT id FROM sections WHERE top_id = ?)', topId);
  store.run('DELETE FROM sections WHERE top_id = ?', topId);
}

export function refreshDocVector(store: Store, docId: number) {
  const vectors = store.docVectors(docId).map((c) => c.vec);
  if (vectors.length) store.run('UPDATE documents SET doc_vec = ? WHERE id = ?', new Uint8Array(meanVector(vectors).buffer), docId);
}

/**
 * Applique la décision de l'utilisateur. Retourne l'identifiant d'un document à supprimer
 * (cas « ignorer l'import »), ou null.
 */
export function decideVersion(store: Store, pendingId: number, action: VersionAction, choices: MergeChoices = {}): number | null {
  const row = store.get<{ new_doc_id: number; old_doc_id: number; report: string }>('SELECT * FROM pending_versions WHERE id = ?', pendingId);
  if (!row) throw new Error('Décision introuvable');
  const report = JSON.parse(row.report) as Report;
  let toDelete: number | null = null;
  store.tx(() => {
    if (action === 'discard') {
      toDelete = row.new_doc_id;
    } else if (action === 'keep-both') {
      store.run("UPDATE documents SET status = 'ready' WHERE id = ?", row.new_doc_id);
    } else {
      if (action === 'merge') {
        report.sections.forEach((section, index) => {
          const choice = choices[index];
          const ord = store.get<{ ord: number }>('SELECT ord FROM sections WHERE id = ?', section.newSectionId ?? -1)?.ord;
          if (section.diff === 'modified' && choice === 'old' && section.newSectionId && section.oldSectionId) {
            dropSection(store, section.newSectionId);
            copySection(store, section.oldSectionId, row.new_doc_id, ord ?? 0);
          } else if (section.diff === 'removed' && choice === 'keep' && section.oldSectionId) {
            const last = store.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) AS m FROM sections WHERE doc_id = ?', row.new_doc_id)?.m ?? 0;
            copySection(store, section.oldSectionId, row.new_doc_id, Math.floor(last) + 1);
          } else if (section.diff === 'added' && choice === 'drop' && section.newSectionId) {
            dropSection(store, section.newSectionId);
          }
        });
        refreshDocVector(store, row.new_doc_id);
      }
      const old = store.get<{ version: number }>('SELECT version FROM documents WHERE id = ?', row.old_doc_id);
      store.run("UPDATE documents SET status = 'archived' WHERE id = ?", row.old_doc_id);
      store.run("UPDATE documents SET status = 'ready', version = ?, supersedes_id = ?, indexed_at = ? WHERE id = ?", (old?.version ?? 1) + 1, row.old_doc_id, now(), row.new_doc_id);
      // Le nouveau document hérite des thèmes de l'ancien.
      store.run('INSERT OR IGNORE INTO doc_categories(doc_id, category_id) SELECT ?, category_id FROM doc_categories WHERE doc_id = ?', row.new_doc_id, row.old_doc_id);
    }
    store.run('DELETE FROM pending_versions WHERE id = ?', pendingId);
  });
  return toDelete;
}
