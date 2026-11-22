// Moteur applicatif : sources, indexation, thèmes, liens, conversations, paramètres.
// Aucune dépendance à Electron : testable tel quel sous Node.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { chunkDocument, embeddingText, meanVector, normalize, sha256 } from './chunker.js';
import { fromBlob, now, toBlob, type Store } from './db.js';
import { maskPii } from './guardrails.js';
import { contentSha, fetchLink, type ConfluenceAccess } from './links.js';
import { CLAUDE_MODELS, parseJsonLoose, type ChatProvider, type Embedder } from './llm.js';
import { parseFile, SUPPORTED_EXTENSIONS, type ParsedDoc } from './parsers.js';
import { answer } from './rag.js';
import { decideVersion, detectVersion, listPending, normTitle } from './versioning.js';
import type {
  AppEvent, AppSettings, CategoryNode, ChatMessage, Conversation, ImportResult, MergeChoices, PendingVersion, SourceDoc, VersionAction,
} from '../../shared/types.js';

export interface EngineDeps {
  store: Store;
  embedder: Embedder;
  embedReady: () => boolean;
  /** Moteur de dialogue local, ou null tant qu'il n'est pas installé. */
  localChat: () => ChatProvider | null;
  makeClaude: (apiKey: string, model: string) => ChatProvider;
  defaultLibraryDir: string;
  /** Chiffrement des secrets (trousseau du système). */
  seal: (plain: string) => string;
  unseal: (sealed: string) => string;
  emit: (event: AppEvent) => void;
  groundThreshold: number;
}

const DEFAULTS = {
  engine: 'local', claudeModel: CLAUDE_MODELS[0], language: 'fr', maskPii: 'true', refreshDays: '7', autoReindex: 'false',
  libraryDir: '', confluenceBaseUrl: '', confluenceUser: '',
} as const;

export class Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private progress = new Map<number, number>();

  constructor(private readonly deps: EngineDeps) {
    // Une indexation interrompue (fermeture de l'application) est signalée en erreur, relançable.
    deps.store.run("UPDATE documents SET status = 'error', error = 'Indexation interrompue' WHERE status = 'indexing'");
  }

  private get store() { return this.deps.store; }
  private setting(key: keyof typeof DEFAULTS): string { return this.store.getSetting(key) ?? DEFAULTS[key]; }
  private secret(name: string): string {
    const sealed = this.store.getSetting(`secret:${name}`);
    if (!sealed) return '';
    try { return this.deps.unseal(sealed); } catch { return ''; }
  }

  // ---------- Paramètres ----------

  getSettings(): AppSettings {
    return {
      engine: this.setting('engine') === 'claude' ? 'claude' : 'local',
      claudeModel: this.setting('claudeModel'),
      hasClaudeKey: !!this.store.getSetting('secret:claudeKey'),
      language: this.setting('language') === 'en' ? 'en' : 'fr',
      maskPii: this.setting('maskPii') === 'true',
      refreshDays: Number(this.setting('refreshDays')) || 0,
      autoReindex: this.setting('autoReindex') === 'true',
      libraryDir: this.libraryDir(),
      confluenceBaseUrl: this.setting('confluenceBaseUrl'),
      confluenceUser: this.setting('confluenceUser'),
      hasConfluenceToken: !!this.store.getSetting('secret:confluenceToken'),
    };
  }

  setSettings(patch: Record<string, unknown>): AppSettings {
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULTS && key !== 'libraryDir' && value !== undefined) this.store.setSetting(key, String(value));
    }
    this.deps.emit({ type: 'status' });
    return this.getSettings();
  }

  setSecret(name: 'claudeKey' | 'confluenceToken', value: string): AppSettings {
    if (value.trim()) this.store.setSetting(`secret:${name}`, this.deps.seal(value.trim()));
    else this.store.deleteSetting(`secret:${name}`);
    this.deps.emit({ type: 'status' });
    return this.getSettings();
  }

  setLibraryDir(dir: string): AppSettings {
    this.store.setSetting('libraryDir', dir);
    return this.getSettings();
  }

  libraryDir(): string {
    const dir = this.store.getSetting('libraryDir') || this.deps.defaultLibraryDir;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private confluence(): ConfluenceAccess | null {
    const baseUrl = this.setting('confluenceBaseUrl');
    const token = this.secret('confluenceToken');
    return baseUrl && token ? { baseUrl, user: this.setting('confluenceUser'), token } : null;
  }

  /** Moteur de dialogue actif selon les paramètres. */
  chat(): ChatProvider | null {
    if (this.setting('engine') === 'claude') {
      const key = this.secret('claudeKey');
      if (key) return this.deps.makeClaude(key, this.setting('claudeModel'));
    }
    return this.deps.localChat();
  }

  // ---------- Sources ----------

  listSources(): SourceDoc[] {
    const docs = this.store.all<Record<string, any>>("SELECT * FROM documents WHERE status != 'archived' ORDER BY created_at DESC, id DESC");
    const cats = this.store.all<{ doc_id: number; id: number; name: string }>('SELECT dc.doc_id, c.id, c.name FROM doc_categories dc JOIN categories c ON c.id = dc.category_id ORDER BY c.name');
    return docs.map((d) => ({
      id: d.id, kind: d.kind, title: d.title, format: d.format, url: d.url, status: d.status, chunking: d.chunking, version: d.version,
      summary: d.summary, indexedAt: d.indexed_at, lastCheckedAt: d.last_checked_at, linkState: d.link_state, refreshDays: d.refresh_days, error: d.error,
      categories: cats.filter((c) => c.doc_id === d.id).map((c) => ({ id: c.id, name: c.name })),
      progress: this.progress.get(d.id),
    }));
  }

  counts() {
    const row = this.store.get<{ total: number; files: number; links: number; changed: number }>(
      `SELECT COUNT(*) AS total, SUM(kind = 'file') AS files, SUM(kind = 'link') AS links, SUM(link_state = 'changed') AS changed
       FROM documents WHERE status != 'archived'`,
    );
    const pending = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM pending_versions')?.n ?? 0;
    return { sources: { total: row?.total ?? 0, files: row?.files ?? 0, links: row?.links ?? 0 }, linksToReindex: row?.changed ?? 0, pendingVersions: pending };
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task, task).catch(() => undefined);
    return this.queue;
  }

  /** Attend la fin des indexations en cours (utile aux tests). */
  idle(): Promise<unknown> { return this.queue; }

  private isDuplicate(sha: string, exceptId = -1): boolean {
    return !!this.store.get("SELECT 1 FROM documents WHERE sha = ? AND status IN ('ready', 'indexing', 'pending') AND id != ?", sha, exceptId);
  }

  async importPaths(paths: string[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, duplicates: [], errors: [] };
    for (const path of paths) {
      const name = basename(path);
      try {
        const ext = extname(path).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new Error(`Format non pris en charge (${ext || 'sans extension'})`);
        const parsed = await parseFile(path);
        if (!parsed.blocks.length) throw new Error('Aucun texte exploitable dans ce fichier');
        const sha = contentSha(parsed);
        if (this.isDuplicate(sha)) { result.duplicates.push(name); continue; }
        // Le fichier est copié dans le dossier de la bibliothèque ; l'original n'est jamais modifié.
        const dir = this.libraryDir();
        let target = join(dir, name);
        for (let i = 2; existsSync(target); i++) target = join(dir, `${basename(name, ext)} (${i})${ext}`);
        copyFileSync(path, target);
        const title = parsed.title || basename(name, ext);
        const id = this.store.insert(
          "INSERT INTO documents(kind, title, norm_title, path, format, sha, status, created_at) VALUES('file', ?, ?, ?, ?, ?, 'indexing', ?)",
          title, normTitle(basename(name, ext)), target, parsed.format, sha, now(),
        );
        result.imported++;
        this.enqueue(() => this.indexSafely(id, { ...parsed, title }, true));
      } catch (error) {
        result.errors.push({ name, message: (error as Error).message });
      }
    }
    this.deps.emit({ type: 'sources' });
    return result;
  }

  async addLink(rawUrl: string): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, duplicates: [], errors: [] };
    const url = rawUrl.trim();
    try {
      if (this.store.get("SELECT 1 FROM documents WHERE url = ? AND status != 'archived'", url)) { result.duplicates.push(url); return result; }
      const fetched = await fetchLink(url, this.confluence());
      const parsed = fetched.parsed!;
      if (this.isDuplicate(fetched.sha!)) { result.duplicates.push(url); return result; }
      const id = this.store.insert(
        `INSERT INTO documents(kind, title, norm_title, url, format, sha, status, created_at, etag, last_modified, remote_version, last_checked_at, link_state, refresh_days)
         VALUES('link', ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?, ?, 'ok', ?)`,
        parsed.title, normTitle(parsed.title), url, parsed.format, fetched.sha, now(), fetched.etag, fetched.lastModified, fetched.remoteVersion, now(), Number(this.setting('refreshDays')) || 0,
      );
      result.imported++;
      this.enqueue(() => this.indexSafely(id, parsed, false));
    } catch (error) {
      result.errors.push({ name: url, message: (error as Error).message });
    }
    this.deps.emit({ type: 'sources' });
    return result;
  }

  /** Réindexe une source : relit le fichier ou recharge la page. */
  async reindex(id: number): Promise<void> {
    const doc = this.store.get<Record<string, any>>('SELECT * FROM documents WHERE id = ?', id);
    if (!doc) return;
    this.store.run("UPDATE documents SET status = 'indexing', error = NULL WHERE id = ?", id);
    this.deps.emit({ type: 'sources' });
    await this.enqueue(async () => {
      try {
        let parsed: ParsedDoc;
        if (doc.kind === 'link') {
          const fetched = await fetchLink(doc.url, this.confluence());
          parsed = fetched.parsed!;
          this.store.run("UPDATE documents SET sha = ?, etag = ?, last_modified = ?, remote_version = ?, last_checked_at = ?, link_state = 'ok', title = ? WHERE id = ?",
            fetched.sha, fetched.etag, fetched.lastModified, fetched.remoteVersion, now(), parsed.title, id);
        } else {
          parsed = await parseFile(doc.path);
          parsed.title = doc.title;
        }
        await this.indexSafely(id, parsed, false);
      } catch (error) {
        this.fail(id, error);
      }
    });
  }

  private fail(id: number, error: unknown) {
    this.progress.delete(id);
    this.store.run("UPDATE documents SET status = 'error', error = ? WHERE id = ?", (error as Error).message.slice(0, 300), id);
    this.deps.emit({ type: 'sources' });
  }

  private async indexSafely(id: number, parsed: ParsedDoc, detect: boolean) {
    try {
      await this.index(id, parsed, detect);
    } catch (error) {
      this.fail(id, error);
    }
  }

  private async index(docId: number, parsed: ParsedDoc, detect: boolean) {
    if (!this.deps.embedReady()) throw new Error('Modèle de vectorisation non installé');
    const { store, embedder } = this.deps;
    const chat = this.chat();
    const setProgress = (value: number) => { this.progress.set(docId, value); this.deps.emit({ type: 'sources' }); };
    setProgress(0.05);

    const titleFor = chat
      ? (text: string) => chat.chat({ system: 'Tu donnes un titre court (8 mots au plus) au passage fourni, dans la langue du passage. Réponds par le titre seul.', prompt: text, maxTokens: 30, light: true })
      : undefined;
    const chunked = await chunkDocument(parsed, (texts) => embedder.embed(texts, 'passage'), titleFor);
    if (!chunked.chunks.length) throw new Error('Aucun texte exploitable');
    setProgress(0.2);

    // Réindexation incrémentale : un passage inchangé (même texte, même emplacement) garde son vecteur.
    const known = new Map<string, Float32Array>();
    for (const row of store.all<{ sha: string; path: string; vec: Uint8Array }>('SELECT c.sha, s.path, c.vec FROM chunks c JOIN sections s ON s.id = c.section_id WHERE c.doc_id = ?', docId)) {
      known.set(`${row.sha}|${row.path}`, fromBlob(row.vec));
    }
    const vectors: Float32Array[] = new Array(chunked.chunks.length);
    const missing: number[] = [];
    chunked.chunks.forEach((chunk, index) => {
      const reused = known.get(`${chunk.sha}|${chunked.sections[chunk.sectionKey].path}`);
      if (reused) vectors[index] = reused; else missing.push(index);
    });
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      const texts = batch.map((index) => embeddingText(parsed.title, chunked.sections[chunked.chunks[index].sectionKey].path, chunked.chunks[index].text));
      const embedded = await embedder.embed(texts, 'passage');
      batch.forEach((index, j) => { vectors[index] = embedded[j]; });
      setProgress(0.2 + 0.6 * Math.min(1, (i + 8) / missing.length));
    }

    store.tx(() => {
      store.clearContent(docId);
      const ids = new Map<number, number>();
      for (const section of chunked.sections) {
        const id = store.insert(
          'INSERT INTO sections(doc_id, parent_id, top_id, level, title, path, ord, synthetic) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
          docId, section.parentKey === null ? null : ids.get(section.parentKey)!, ids.get(section.topKey) ?? null, section.level, section.title, section.path, section.key, section.synthetic ? 1 : 0,
        );
        ids.set(section.key, id);
        if (section.topKey === section.key) store.run('UPDATE sections SET top_id = ? WHERE id = ?', id, id);
      }
      chunked.chunks.forEach((chunk, index) => store.addChunk(docId, ids.get(chunk.sectionKey)!, chunk.ord, chunk.text, chunk.sha, vectors[index]));
      store.run('UPDATE documents SET chunking = ?, doc_vec = ?, title = ? WHERE id = ?', chunked.mode, toBlob(meanVector(vectors)), parsed.title, docId);
    });
    setProgress(0.85);

    await this.describe(docId, parsed, chat);

    const pending = detect && detectVersion(store, docId);
    store.run('UPDATE documents SET status = ?, indexed_at = ?, error = NULL WHERE id = ?', pending ? 'pending' : 'ready', now(), docId);
    this.progress.delete(docId);
    this.deps.emit({ type: 'sources' });
    this.deps.emit({ type: 'status' });
  }

  /** Résumé du document et proposition de thèmes (réutilise les thèmes existants quand ils conviennent). */
  private async describe(docId: number, parsed: ParsedDoc, chat: ChatProvider | null) {
    const { store } = this.deps;
    const body = parsed.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const fallback = body.replace(/\s+/g, ' ').slice(0, 180);
    const hasCategories = !!store.get('SELECT 1 FROM doc_categories WHERE doc_id = ?', docId);
    let summary = fallback;
    let themes: string[] = [];
    if (chat) {
      try {
        const existing = store.all<{ name: string }>('SELECT name FROM categories ORDER BY name').map((c) => c.name);
        const headings = parsed.blocks.filter((b) => b.type === 'heading').slice(0, 25).map((b) => b.text).join(' ; ');
        const request = {
          system: 'Tu analyses un document pour une base de connaissances. Tu produis un résumé d’une phrase (25 mots au plus) et de 1 à 3 thèmes courts (1 à 3 mots, sans nom de personne). Un thème décrit le sujet principal du document (par exemple « Architecture », « Facturation », « Exploitation »). Réutilise un thème existant seulement s’il correspond vraiment au sujet ; sinon propose-en un nouveau. Rédige dans la langue du document.',
          prompt: `Thèmes existants : ${existing.join(', ') || 'aucun'}\nTitre : ${parsed.title}\nSections : ${headings || 'aucune'}\nDébut du texte :\n${maskPii(body.slice(0, 2500)).text}`,
          maxTokens: 320, light: true,
          jsonSchema: {
            type: 'object',
            // Les thèmes d'abord : ils sont produits même si le résumé est tronqué.
            properties: { themes: { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: 3 }, summary: { type: 'string', maxLength: 260 } },
            required: ['themes', 'summary'], additionalProperties: false,
          },
        };
        // Une sortie tronquée ou mal formée est retentée une fois.
        let parsedJson = parseJsonLoose<{ summary?: string; themes?: string[] }>(await chat.chat(request));
        parsedJson ??= parseJsonLoose<{ summary?: string; themes?: string[] }>(await chat.chat(request));
        if (!parsedJson && process.env['RAG_DEBUG']) console.warn('describe: JSON illisible', await chat.chat(request));
        if (parsedJson?.summary) summary = parsedJson.summary.slice(0, 300);
        themes = (parsedJson?.themes ?? []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 3);
      } catch (error) {
        // Le résumé de repli suffit.
        if (process.env['RAG_DEBUG']) console.warn('describe:', error);
      }
    }
    store.run('UPDATE documents SET summary = ? WHERE id = ?', maskPii(summary).text, docId);
    if (!hasCategories) {
      for (const theme of themes) {
        const found = store.get<{ id: number }>('SELECT id FROM categories WHERE lower(name) = lower(?)', theme);
        const categoryId = found?.id ?? store.insert('INSERT INTO categories(name, parent_id) VALUES(?, NULL)', theme);
        store.run('INSERT OR IGNORE INTO doc_categories(doc_id, category_id) VALUES(?, ?)', docId, categoryId);
      }
    }
  }

  removeSource(id: number) {
    const doc = this.store.get<{ path: string | null }>('SELECT path FROM documents WHERE id = ?', id);
    if (!doc) return;
    this.store.deleteDocument(id);
    // Seule la copie située dans le dossier de la bibliothèque est supprimée.
    if (doc.path && resolve(doc.path).startsWith(resolve(this.libraryDir()) + sep) &&
        !this.store.get('SELECT 1 FROM documents WHERE path = ?', doc.path)) {
      rmSync(doc.path, { force: true });
    }
    this.deps.emit({ type: 'sources' });
    this.deps.emit({ type: 'status' });
  }

  setCategories(docId: number, categoryIds: number[]) {
    this.store.tx(() => {
      this.store.run('DELETE FROM doc_categories WHERE doc_id = ?', docId);
      for (const id of categoryIds) this.store.run('INSERT OR IGNORE INTO doc_categories(doc_id, category_id) VALUES(?, ?)', docId, id);
    });
    this.deps.emit({ type: 'sources' });
  }

  // ---------- Versions ----------

  pendingVersions(): PendingVersion[] { return listPending(this.store); }

  decide(id: number, action: VersionAction, choices?: MergeChoices) {
    const toDelete = decideVersion(this.store, id, action, choices);
    if (toDelete !== null) this.removeSource(toDelete);
    this.deps.emit({ type: 'sources' });
    this.deps.emit({ type: 'status' });
  }

  // ---------- Liens ----------

  /** Vérifie les liens arrivés à échéance (ou tous si `force`) et signale ceux qui ont changé. */
  async checkLinks(force = false): Promise<void> {
    const days = Number(this.setting('refreshDays')) || 0;
    if (!force && days === 0) return;
    const links = this.store.all<Record<string, any>>("SELECT * FROM documents WHERE kind = 'link' AND status = 'ready'");
    const auto = this.setting('autoReindex') === 'true';
    for (const link of links) {
      const due = !link.last_checked_at || Date.now() - Date.parse(link.last_checked_at) >= days * 86_400_000;
      if (!force && !due) continue;
      try {
        const fetched = await fetchLink(link.url, this.confluence(), { etag: link.etag, lastModified: link.last_modified, remoteVersion: link.remote_version });
        const changed = !fetched.notModified && fetched.sha !== link.sha;
        this.store.run('UPDATE documents SET last_checked_at = ?, link_state = ? WHERE id = ?', now(), changed ? 'changed' : 'ok', link.id);
        if (changed && auto) await this.reindex(link.id);
      } catch {
        this.store.run("UPDATE documents SET last_checked_at = ?, link_state = 'unreachable' WHERE id = ?", now(), link.id);
      }
    }
    this.deps.emit({ type: 'sources' });
    this.deps.emit({ type: 'status' });
  }

  // ---------- Thèmes ----------

  categoryTree(): CategoryNode[] {
    const rows = this.store.all<{ id: number; name: string; parent_id: number | null; n: number }>(
      `SELECT c.id, c.name, c.parent_id, (SELECT COUNT(*) FROM doc_categories dc JOIN documents d ON d.id = dc.doc_id
        WHERE dc.category_id = c.id AND d.status IN ('ready', 'indexing')) AS n FROM categories c ORDER BY c.name COLLATE NOCASE`,
    );
    const nodes = new Map<number, CategoryNode>(rows.map((r) => [r.id, { id: r.id, name: r.name, parentId: r.parent_id, count: r.n, children: [] }]));
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId === null ? null : nodes.get(node.parentId);
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return roots;
  }

  createCategory(name: string, parentId: number | null) {
    const clean = name.trim().slice(0, 40);
    if (clean) this.store.run('INSERT INTO categories(name, parent_id) VALUES(?, ?)', clean, parentId);
  }

  renameCategory(id: number, name: string) {
    const clean = name.trim().slice(0, 40);
    if (clean) this.store.run('UPDATE categories SET name = ? WHERE id = ?', clean, id);
    this.deps.emit({ type: 'sources' });
  }

  removeCategory(id: number) {
    this.store.tx(() => {
      const parent = this.store.get<{ parent_id: number | null }>('SELECT parent_id FROM categories WHERE id = ?', id)?.parent_id ?? null;
      this.store.run('UPDATE categories SET parent_id = ? WHERE parent_id = ?', parent, id);
      this.store.run('DELETE FROM doc_categories WHERE category_id = ?', id);
      this.store.run('DELETE FROM categories WHERE id = ?', id);
    });
    this.deps.emit({ type: 'sources' });
  }

  /** Documents d'un thème et de ses sous-thèmes. */
  private docsInCategory(categoryId: number): number[] {
    const ids = [categoryId];
    for (let i = 0; i < ids.length; i++) {
      for (const child of this.store.all<{ id: number }>('SELECT id FROM categories WHERE parent_id = ?', ids[i])) ids.push(child.id);
    }
    return this.store.all<{ doc_id: number }>(`SELECT DISTINCT doc_id FROM doc_categories WHERE category_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.doc_id);
  }

  // ---------- Conversations ----------

  conversations(): Conversation[] {
    return this.store.all<{ id: number; title: string; created_at: string }>('SELECT * FROM conversations ORDER BY id DESC LIMIT 50')
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.created_at }));
  }

  messages(conversationId: number): ChatMessage[] {
    return this.store.all<Record<string, any>>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', conversationId).map((m) => {
      const payload = JSON.parse(m.payload) as { citations?: ChatMessage['citations']; documents?: ChatMessage['documents'] };
      return {
        id: m.id, conversationId: m.conversation_id, role: m.role, content: m.content, kind: m.kind,
        citations: payload.citations ?? [], documents: payload.documents ?? [], engine: m.engine, createdAt: m.created_at,
      };
    });
  }

  removeConversation(conversationId: number) {
    this.store.run('DELETE FROM messages WHERE conversation_id = ?', conversationId);
    this.store.run('DELETE FROM conversations WHERE id = ?', conversationId);
  }

  async send(conversationId: number | null, text: string, categoryId: number | null, requestId: string): Promise<{ conversationId: number; message: ChatMessage }> {
    const question = text.trim().slice(0, 4000);
    if (!question) throw new Error('Question vide');
    const settings = this.getSettings();
    const convId = conversationId ?? this.store.insert('INSERT INTO conversations(title, created_at) VALUES(?, ?)',
      maskPii(question.length > 48 ? `${question.slice(0, 47)}…` : question).text, now());
    const history = this.messages(convId).map((m) => ({ role: m.role, content: m.content }));
    const stored = settings.maskPii ? maskPii(question).text : question;
    this.store.run("INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?, 'user', ?, ?)", convId, stored, now());

    const result = await answer(
      {
        store: this.store, embedder: this.deps.embedder, embedReady: this.deps.embedReady(), chat: this.chat(),
        language: settings.language, maskPii: settings.maskPii, groundThreshold: this.deps.groundThreshold,
      },
      {
        text: question, history, docIds: categoryId === null ? null : this.docsInCategory(categoryId),
        onToken: (token) => this.deps.emit({ type: 'token', requestId, text: token }),
      },
    );
    const id = this.store.insert(
      "INSERT INTO messages(conversation_id, role, content, kind, payload, engine, created_at) VALUES(?, 'assistant', ?, ?, ?, ?, ?)",
      convId, result.content, result.kind, JSON.stringify({ citations: result.citations, documents: result.documents }), result.engine, now(),
    );
    return { conversationId: convId, message: this.messages(convId).find((m) => m.id === id)! };
  }
}

export { normalize, sha256 };
