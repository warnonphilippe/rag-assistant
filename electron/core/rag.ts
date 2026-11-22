// Dialogue : routage d'intention, recherche hybride, réponse citée, repli sur les connaissances du modèle.
import { STOPWORDS, type Store } from './db.js';
import { maskPii, moderate, REFUSAL_MARK, SAFETY_PROMPT } from './guardrails.js';
import { parseJsonLoose, RefusedError, type ChatProvider, type Embedder } from './llm.js';
import type { AnswerKind, Citation, DocHit, SourceKind } from '../../shared/types.js';

export type Intent = 'question' | 'documents';

const DOC_WORDS = '(?:documents?|docs?|fichiers?|sources?|pages?|liens?|références?|references?|files?|links?)';
const DOC_PATTERNS = [
  new RegExp(`(?:quel(?:le)?s?|liste[rz]?|lister|donne[sz]?[- ]moi|montre[sz]?[- ]moi|trouve[rsz]?|cherche[rsz]?|recherche[rsz]?|y a[- ]t[- ]il|existe[- ]t[- ]il|as[- ]tu|avez[- ]vous|où (?:est|sont|trouver)|dans quel(?:le)?s?)\\b.{0,50}\\b${DOC_WORDS}`, 'i'),
  new RegExp(`\\b${DOC_WORDS} (?:qui|parlant|traitant|concernant|portant|sur|à propos|au sujet)\\b`, 'i'),
  new RegExp(`(?:which|what|list|show me|find|search for|give me|any|are there|do you have|where (?:is|are|can))\\b.{0,50}\\b${DOC_WORDS}`, 'i'),
  new RegExp(`\\b${DOC_WORDS} (?:about|that|on|covering|related to|dealing with|regarding)\\b`, 'i'),
];
const MENTIONS_DOCS = new RegExp(`\\b${DOC_WORDS}\\b`, 'i');

/** Heuristique : la personne demande-t-elle une liste de documents plutôt qu'une réponse ? */
export function heuristicIntent(text: string): Intent | 'ambiguous' {
  if (DOC_PATTERNS.some((p) => p.test(text))) return 'documents';
  return MENTIONS_DOCS.test(text) ? 'ambiguous' : 'question';
}

export async function detectIntent(text: string, chat: ChatProvider | null): Promise<Intent> {
  const guess = heuristicIntent(text);
  if (guess !== 'ambiguous') return guess;
  if (!chat) return 'question';
  try {
    const raw = await chat.chat({
      system: 'Tu classes une demande. "documents" si la personne veut obtenir une liste de documents ou de sources traitant d’un sujet ; "question" si elle veut une réponse à une question.',
      prompt: text, maxTokens: 20, light: true,
      jsonSchema: { type: 'object', properties: { intent: { enum: ['documents', 'question'] } }, required: ['intent'], additionalProperties: false },
    });
    return parseJsonLoose<{ intent: Intent }>(raw)?.intent === 'documents' ? 'documents' : 'question';
  } catch {
    return 'question';
  }
}

interface Hit { id: number; sim: number; rrf: number; keyword: boolean }

interface ChunkRow {
  id: number; text: string; doc_id: number; doc_title: string; kind: SourceKind; format: string; section: string;
}

/** Recherche hybride : vecteurs + mots-clés, fusionnés par rangs réciproques (RRF). */
export async function hybridSearch(store: Store, embedder: Embedder, query: string, docIds: number[] | null, limit = 12): Promise<Hit[]> {
  const [vector] = await embedder.embed([query], 'query');
  const byVector = store.vectorSearch(vector, 40, docIds);
  const byKeyword = store.keywordSearch(query, 40, docIds);
  const hits = new Map<number, Hit>();
  byVector.forEach((r, rank) => hits.set(r.id, { id: r.id, sim: r.score, rrf: 1 / (60 + rank), keyword: false }));
  byKeyword.forEach((r, rank) => {
    const hit = hits.get(r.id) ?? { id: r.id, sim: 0, rrf: 0, keyword: true };
    hit.rrf += 1 / (60 + rank);
    hit.keyword = true;
    hits.set(r.id, hit);
  });
  return [...hits.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}

const rows = (store: Store, ids: number[]): Map<number, ChunkRow> => {
  if (!ids.length) return new Map();
  const list = store.all<ChunkRow>(
    `SELECT c.id AS id, c.text AS text, d.id AS doc_id, d.title AS doc_title, d.kind AS kind, d.format AS format, s.path AS section
     FROM chunks c JOIN documents d ON d.id = c.doc_id JOIN sections s ON s.id = c.section_id WHERE c.id IN (${ids.map(() => '?').join(',')})`, ...ids,
  );
  return new Map(list.map((r) => [r.id, r]));
};

const excerpt = (text: string, mask: boolean) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > 220 ? `${flat.slice(0, 217).trimEnd()}…` : flat;
  return mask ? maskPii(cut).text : cut;
};

const TEXTS = {
  fr: {
    refused: 'Je ne peux pas répondre à cette demande : elle sort du cadre de cet assistant documentaire.',
    noDocs: 'Aucun document indexé ne traite de ce sujet.',
    docs: (n: number) => (n > 1 ? `${n} documents traitent de ce sujet.` : '1 document traite de ce sujet.'),
    noEngine: 'Le modèle de dialogue n’est pas encore disponible. Installez les modèles locaux ou renseignez une clé Claude dans les paramètres.',
    noSourceNoEngine: 'Aucune source indexée ne traite ce sujet.',
  },
  en: {
    refused: 'I can’t help with this request: it falls outside the scope of this document assistant.',
    noDocs: 'No indexed document covers this topic.',
    docs: (n: number) => (n > 1 ? `${n} documents cover this topic.` : '1 document covers this topic.'),
    noEngine: 'The chat model is not available yet. Install the local models or add a Claude key in the settings.',
    noSourceNoEngine: 'No indexed source covers this topic.',
  },
};

const EN_WORDS = /\b(the|what|which|how|why|is|are|does|do|of|and|for|with|about|can|should|where|when|who)\b/gi;
const FR_WORDS = /\b(le|la|les|des|est|sont|quel|quels|quelle|quelles|comment|pourquoi|que|qui|pour|avec|dans|sur|une|du|où|quand)\b/gi;

/** Consigne de langue explicite : les petits modèles suivent mal « la langue de la question ». */
export function languageHint(question: string, fallback: 'fr' | 'en'): string {
  const en = (question.match(EN_WORDS) ?? []).length;
  const fr = (question.match(FR_WORDS) ?? []).length;
  const lang = en === fr ? fallback : en > fr ? 'en' : 'fr';
  return lang === 'en' ? 'Answer in English.' : 'Réponds en français.';
}

export const OUT_OF_SOURCES = '[[HORS_SOURCES]]';

export interface RagContext {
  store: Store;
  embedder: Embedder;
  embedReady: boolean;
  chat: ChatProvider | null;
  language: 'fr' | 'en';
  maskPii: boolean;
  /** Cosinus minimal pour considérer qu'une feuille répond à la question. */
  groundThreshold: number;
}

export interface RagAnswer {
  content: string;
  kind: AnswerKind;
  citations: Citation[];
  documents: DocHit[];
  engine: string | null;
}

export interface RagRequest {
  text: string;
  docIds: number[] | null;      // filtre de thème
  history: { role: 'user' | 'assistant'; content: string }[];
  onToken?: (text: string) => void;
}

/** N'émet les jetons qu'une fois certain que la réponse n'est pas un marqueur interne. */
function gatedStream(onToken?: (text: string) => void) {
  let buffer = '';
  let open = false;
  return (text: string) => {
    if (!onToken) return;
    if (open) { onToken(text); return; }
    buffer += text;
    const trimmed = buffer.trimStart();
    if (trimmed.startsWith('[[') || '[['.startsWith(trimmed)) return;
    if (trimmed.length >= 2) { open = true; onToken(buffer); }
  };
}

export async function answer(ctx: RagContext, request: RagRequest): Promise<RagAnswer> {
  const t = TEXTS[ctx.language];
  const clean = (text: string) => (ctx.maskPii ? maskPii(text).text : text);
  const refused = (): RagAnswer => ({ content: t.refused, kind: 'refused', citations: [], documents: [], engine: null });

  if (moderate(request.text)) return refused();

  const hasSources = ctx.embedReady && !!ctx.store.get("SELECT 1 FROM documents WHERE status = 'ready' LIMIT 1");
  const intent = await detectIntent(request.text, ctx.chat);
  // Pour une demande de liste, on cherche le sujet et non la formule (« quels documents parlent de… »).
  const subject = (request.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)).join(' ');
  const query = intent === 'documents' && subject ? subject : request.text;
  const hits = hasSources ? await hybridSearch(ctx.store, ctx.embedder, query, request.docIds) : [];
  const data = rows(ctx.store, hits.map((h) => h.id));
  const bestSim = hits.reduce((max, h) => Math.max(max, h.sim), 0);
  const relevant = hits.filter((h) => data.has(h.id) && (h.sim >= ctx.groundThreshold || (h.keyword && h.sim >= ctx.groundThreshold * 0.8)));

  // --- Liste de documents ---
  if (intent === 'documents') {
    const perDoc = new Map<number, { score: number; best: Hit }>();
    for (const hit of relevant) {
      const row = data.get(hit.id)!;
      const entry = perDoc.get(row.doc_id);
      if (!entry) perDoc.set(row.doc_id, { score: hit.rrf, best: hit });
      else { entry.score += hit.rrf; if (hit.rrf > entry.best.rrf) entry.best = hit; }
    }
    const documents: DocHit[] = [...perDoc.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([docId, entry]) => {
      const row = data.get(entry.best.id)!;
      const categories = ctx.store.all<{ name: string }>('SELECT c.name FROM categories c JOIN doc_categories dc ON dc.category_id = c.id WHERE dc.doc_id = ?', docId).map((c) => c.name);
      return { docId, title: row.doc_title, kind: row.kind, format: row.format, section: row.section, excerpt: excerpt(row.text, ctx.maskPii), categories };
    });
    if (!documents.length) return { content: t.noDocs, kind: 'empty', citations: [], documents: [], engine: null };
    return { content: t.docs(documents.length), kind: 'documents', citations: [], documents, engine: null };
  }

  // --- Réponse rédigée ---
  if (!ctx.chat) {
    return { content: relevant.length ? t.noEngine : `${t.noSourceNoEngine} ${t.noEngine}`, kind: 'empty', citations: [], documents: [], engine: null };
  }
  const chat = ctx.chat;
  const hint = languageHint(request.text, ctx.language);
  const history = request.history.slice(-4).map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.content.slice(0, 500)}`).join('\n');
  const finish = (raw: string, kind: AnswerKind, citations: Citation[]): RagAnswer => {
    if (raw.includes(REFUSAL_MARK) || moderate(raw)) return refused();
    return { content: clean(raw), kind, citations, documents: [], engine: chat.label };
  };

  try {
    const grounded = relevant.length > 0 && bestSim >= ctx.groundThreshold * 0.8;
    if (grounded) {
      const context = relevant.slice(0, 6);
      const citations: Citation[] = context.map((hit, index) => {
        const row = data.get(hit.id)!;
        return { n: index + 1, docId: row.doc_id, docTitle: row.doc_title, format: row.format, kind: row.kind, section: row.section, excerpt: excerpt(row.text, ctx.maskPii) };
      });
      // Les extraits sont masqués avant d'être transmis au modèle (local ou distant).
      const passages = context.map((hit, index) => {
        const row = data.get(hit.id)!;
        return `[${index + 1}] (${row.doc_title} — ${row.section})\n${clean(row.text).slice(0, 1600)}`;
      }).join('\n\n');
      const raw = await chat.chat({
        system: `Tu es un assistant documentaire. Tu réponds à la question uniquement à partir des extraits numérotés fournis. Cite chaque source par son numéro entre crochets, par exemple [1], juste après l’affirmation qu’elle appuie. Si les extraits ne permettent pas de répondre à la question, réponds exactement ${OUT_OF_SOURCES} et rien d’autre. Réponds de façon précise et concise.\n${SAFETY_PROMPT}`,
        prompt: `Extraits :\n${passages}\n\n${history ? `Échanges précédents :\n${history}\n\n` : ''}Question : ${request.text}\n\n${hint}`,
        maxTokens: 900,
        onToken: gatedStream(request.onToken),
      });
      if (!raw.includes(OUT_OF_SOURCES)) {
        const cited = new Set([...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
        const used = citations.filter((c) => cited.has(c.n));
        return finish(raw, 'grounded', used.length ? used : citations.slice(0, 3));
      }
    }
    const raw = await chat.chat({
      system: `Tu es un assistant technique. Aucune source documentaire de l’utilisateur ne couvre la question : réponds à partir de tes connaissances générales, brièvement, en signalant toute incertitude.\n${SAFETY_PROMPT}`,
      prompt: `${history ? `Échanges précédents :\n${history}\n\n` : ''}Question : ${request.text}\n\n${hint}`,
      maxTokens: 700,
      onToken: gatedStream(request.onToken),
    });
    return finish(raw, 'model', []);
  } catch (error) {
    if (error instanceof RefusedError) return refused();
    throw error;
  }
}
