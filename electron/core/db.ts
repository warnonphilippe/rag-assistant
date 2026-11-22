// Stockage : un fichier SQLite (node:sqlite) avec FTS5 pour les mots-clés et sqlite-vec pour les vecteurs.
import { DatabaseSync } from 'node:sqlite';
import { cosine } from './chunker.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  norm_title TEXT NOT NULL,
  path TEXT,
  url TEXT,
  format TEXT NOT NULL,
  sha TEXT,
  status TEXT NOT NULL,
  chunking TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  doc_vec BLOB,
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  remote_version TEXT,
  last_checked_at TEXT,
  link_state TEXT,
  refresh_days INTEGER NOT NULL DEFAULT 7,
  error TEXT
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  parent_id INTEGER,
  top_id INTEGER,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  ord INTEGER NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sections_doc ON sections(doc_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  sha TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER
);
CREATE TABLE IF NOT EXISTS doc_categories (
  doc_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (doc_id, category_id)
);
CREATE TABLE IF NOT EXISTS pending_versions (
  id INTEGER PRIMARY KEY,
  new_doc_id INTEGER NOT NULL,
  old_doc_id INTEGER NOT NULL,
  report TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  engine TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Mots vides (français / anglais) et mots de la demande elle-même, ignorés par la recherche par mots-clés. */
export const STOPWORDS = new Set(`les des une aux est sont pour par sur dans avec que qui quoi quel quels quelle quelles comment pourquoi quand
ou et mais donc car pas plus moins entre vers chez sans sous ces ses mes tes nos vos leur leurs cet cette son mon ton elle elles ils nous vous
doit doivent peut peuvent fait faire avoir etre être ont ete été sera seront ainsi aussi tres très tout tous toute toutes
the and for are was were with that this these those from what which who how why when where can could should would does did has have had not any
all into about your our their there here than then them they you
document documents doc docs fichier fichiers source sources page pages lien liens file files link links
parle parlent parlant traite traitent traitant concerne concernent concernant propos sujet liste lister donne montre trouve cherche existe
about covering cover covers list show find give regarding related`.split(/\s+/));

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
export const now = () => new Date().toISOString();

export type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  /** Vrai si l'extension sqlite-vec est chargée (sinon le cosinus est calculé en JavaScript). */
  vecLoaded = false;

  constructor(file: string, vecExtensionPath?: string | null) {
    this.db = new DatabaseSync(file, { allowExtension: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    if (vecExtensionPath) {
      try {
        this.db.loadExtension(vecExtensionPath);
        this.vecLoaded = true;
      } catch {
        this.vecLoaded = false;
      }
    }
    this.db.exec(SCHEMA);
  }

  all<T = Row>(sql: string, ...params: any[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  get<T = Row>(sql: string, ...params: any[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  insert(sql: string, ...params: any[]): number { return Number(this.run(sql, ...params).lastInsertRowid); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSetting(key: string): string | null { return this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null; }
  setSetting(key: string, value: string) { this.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
  deleteSetting(key: string) { this.run('DELETE FROM settings WHERE key = ?', key); }

  /** Supprime sections, feuilles et index d'un document (pas la ligne document). */
  clearContent(docId: number) {
    this.run('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)', docId);
    this.run('DELETE FROM chunks WHERE doc_id = ?', docId);
    this.run('DELETE FROM sections WHERE doc_id = ?', docId);
  }

  deleteDocument(docId: number) {
    this.tx(() => {
      this.clearContent(docId);
      this.run('DELETE FROM doc_categories WHERE doc_id = ?', docId);
      this.run('DELETE FROM pending_versions WHERE new_doc_id = ? OR old_doc_id = ?', docId, docId);
      this.run('DELETE FROM documents WHERE id = ?', docId);
    });
  }

  addChunk(docId: number, sectionId: number, ord: number, text: string, sha: string, vec: Float32Array): number {
    const id = this.insert('INSERT INTO chunks(doc_id, section_id, ord, text, sha, vec) VALUES(?, ?, ?, ?, ?, ?)', docId, sectionId, ord, text, sha, toBlob(vec));
    this.run('INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)', id, text);
    return id;
  }

  /** Recherche vectorielle sur les feuilles des documents actifs (filtre de thème optionnel). */
  vectorSearch(query: Float32Array, limit: number, docIds: number[] | null): { id: number; score: number }[] {
    const filter = docIds ? `AND c.doc_id IN (${docIds.map(() => '?').join(',') || 'NULL'})` : '';
    const params = docIds ?? [];
    if (this.vecLoaded) {
      return this.all<{ id: number; d: number }>(
        `SELECT c.id AS id, vec_distance_cosine(c.vec, ?) AS d FROM chunks c JOIN documents d ON d.id = c.doc_id
         WHERE d.status = 'ready' ${filter} ORDER BY d ASC LIMIT ?`,
        toBlob(query), ...params, limit,
      ).map((r) => ({ id: r.id, score: 1 - r.d }));
    }
    const rows = this.all<{ id: number; vec: Uint8Array }>(
      `SELECT c.id AS id, c.vec AS vec FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.status = 'ready' ${filter}`, ...params,
    );
    return rows.map((r) => ({ id: r.id, score: cosine(query, fromBlob(r.vec)) })).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Recherche plein texte (BM25) sur les feuilles des documents actifs. */
  keywordSearch(query: string, limit: number, docIds: number[] | null): { id: number; score: number }[] {
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t)).slice(0, 12);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const filter = docIds ? `AND c.doc_id IN (${docIds.map(() => '?').join(',') || 'NULL'})` : '';
    try {
      return this.all<{ id: number; rank: number }>(
        `SELECT c.id AS id, bm25(chunks_fts) AS rank FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN documents d ON d.id = c.doc_id WHERE chunks_fts MATCH ? AND d.status = 'ready' ${filter} ORDER BY rank LIMIT ?`,
        match, ...(docIds ?? []), limit,
      ).map((r) => ({ id: r.id, score: -r.rank }));
    } catch {
      return [];
    }
  }

  docVectors(docId: number): { id: number; sectionId: number; sha: string; vec: Float32Array }[] {
    return this.all<{ id: number; section_id: number; sha: string; vec: Uint8Array }>('SELECT id, section_id, sha, vec FROM chunks WHERE doc_id = ? ORDER BY ord', docId)
      .map((r) => ({ id: r.id, sectionId: r.section_id, sha: r.sha, vec: fromBlob(r.vec) }));
  }

  close() { this.db.close(); }
}
