// Moteurs : vectorisation locale, dialogue local (node-llama-cpp) ou Claude (clé API facultative).
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelState } from '../../shared/types.js';

export interface ChatRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  onToken?: (text: string) => void;
  /** Schéma JSON : la réponse est alors un objet JSON conforme. */
  jsonSchema?: Record<string, unknown>;
  /** Tâche courte et simple (classement, titre) : effort minimal. */
  light?: boolean;
}

export interface ChatProvider {
  readonly label: string;
  chat(request: ChatRequest): Promise<string>;
}

export interface Embedder {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

export class RefusedError extends Error {}

export function parseJsonLoose<T>(raw: string): T | null {
  let text = raw.trim();
  // Certains modèles locaux omettent l'accolade ouvrante en sortie contrainte.
  if (text.startsWith('"') && text.endsWith('}')) text = `{${text}`;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { return null; }
}

// ---------- Modèles locaux ----------

export const MODEL_FILES = {
  chat: {
    label: 'Qwen 3.5 4B (dialogue)',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    legacyFile: 'qwen3.5-4b-q4_k_m.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sizeGb: 2.7,
  },
  embed: {
    label: 'Qwen3 Embedding 0.6B (vectorisation)',
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    legacyFile: 'qwen3-embedding-0.6b-q8_0.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
    sizeGb: 0.64,
  },
} as const;

type ModelId = keyof typeof MODEL_FILES;

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Gère le téléchargement et le chargement des modèles GGUF locaux. */
export class LocalModels implements Embedder, ChatProvider {
  readonly label = 'Modèle local Qwen';
  private states: Record<ModelId, ModelState>;
  private llama: any = null;
  private embedContext: any = null;
  private chatModel: any = null;
  private chatContext: any = null;
  private chatSequence: any = null;
  private readonly chatLock = new Mutex();
  private readonly embedLock = new Mutex();
  private downloading: Promise<void> | null = null;

  constructor(private readonly dir: string, private readonly onChange: () => void) {
    mkdirSync(dir, { recursive: true });
    const state = (id: ModelId): ModelState => ({
      id, label: MODEL_FILES[id].label, installed: existsSync(this.pathOf(id)),
      downloading: false, progress: 0, sizeGb: MODEL_FILES[id].sizeGb, error: null,
    });
    this.states = { chat: state('chat'), embed: state('embed') };
  }

  /**
   * Fichier du modèle : nom publié sur Hugging Face (commun aux autres applications quand le dossier est
   * partagé) ; un fichier déjà téléchargé sous l'ancien nom en minuscules reste utilisé.
   */
  private pathOf(id: ModelId): string {
    const current = join(this.dir, MODEL_FILES[id].file);
    const legacy = join(this.dir, MODEL_FILES[id].legacyFile);
    return !existsSync(current) && existsSync(legacy) ? legacy : current;
  }

  list(): ModelState[] { return [this.states.embed, this.states.chat]; }
  get embedReady() { return this.states.embed.installed; }
  get chatReady() { return this.states.chat.installed; }

  /** Télécharge les modèles manquants (depuis Hugging Face) dans le dossier de l'application. */
  download(): Promise<void> {
    this.downloading ??= this.downloadMissing().finally(() => { this.downloading = null; });
    return this.downloading;
  }

  private async downloadMissing() {
    const { createModelDownloader } = await import('node-llama-cpp');
    for (const id of ['embed', 'chat'] as ModelId[]) {
      const state = this.states[id];
      if (state.installed) continue;
      state.downloading = true; state.error = null; state.progress = 0;
      this.onChange();
      const partial = `${MODEL_FILES[id].file}.part`;
      let lastNotified = 0;
      try {
        const downloader = await createModelDownloader({
          modelUri: MODEL_FILES[id].url, dirPath: this.dir, fileName: partial, showCliProgress: false, skipExisting: false,
          onProgress: ({ totalSize, downloadedSize }: { totalSize: number; downloadedSize: number }) => {
            state.progress = totalSize ? downloadedSize / totalSize : 0;
            if (Date.now() - lastNotified > 500) { lastNotified = Date.now(); this.onChange(); }
          },
        });
        await downloader.download();
        renameSync(join(this.dir, partial), join(this.dir, MODEL_FILES[id].file));
        state.installed = true; state.progress = 1;
      } catch (error) {
        state.error = (error as Error).message;
        rmSync(join(this.dir, partial), { force: true });
      } finally {
        state.downloading = false;
        this.onChange();
      }
    }
  }

  private async engine() {
    if (!this.llama) {
      const { getLlama } = await import('node-llama-cpp');
      this.llama = await getLlama({ build: 'never' }); // jamais de compilation sur la machine hôte
    }
    return this.llama;
  }

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    return this.embedLock.run(async () => {
      if (!this.embedContext) {
        const llama = await this.engine();
        const model = await llama.loadModel({ modelPath: this.pathOf('embed') });
        this.embedContext = await model.createEmbeddingContext({ contextSize: 2048 });
      }
      const out: Float32Array[] = [];
      for (const text of texts) {
        const input = kind === 'query'
          ? `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${text}`
          : text;
        const embedding = await this.embedContext.getEmbeddingFor(input.slice(0, 6000));
        out.push(Float32Array.from(embedding.vector));
      }
      return out;
    });
  }

  async chat(request: ChatRequest): Promise<string> {
    return this.chatLock.run(async () => {
      const { LlamaChatSession } = await import('node-llama-cpp');
      const llama = await this.engine();
      if (!this.chatContext) {
        this.chatModel = await llama.loadModel({ modelPath: this.pathOf('chat') });
        this.chatContext = await this.chatModel.createContext({ contextSize: 8192 });
        this.chatSequence = this.chatContext.getSequence();
      }
      // Une seule séquence, réutilisée : chaque demande repart d'une session neuve.
      const sequence = this.chatSequence;
      const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: request.system });
      try {
        const grammar = request.jsonSchema ? await llama.createGrammarForJsonSchema(request.jsonSchema) : undefined;
        const answer: string = await session.prompt(request.prompt, {
          maxTokens: request.maxTokens ?? 900,
          temperature: request.jsonSchema ? 0.1 : 0.3,
          repeatPenalty: { penalty: 1.15, lastTokens: 128 },
          grammar,
          budgets: { thoughtTokens: 0 },
          onTextChunk: request.onToken,
        });
        return answer.trim();
      } finally {
        session.dispose();
      }
    });
  }
}

// ---------- Claude (facultatif) ----------

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export class ClaudeProvider implements ChatProvider {
  readonly label: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
    this.label = `Claude (${model})`;
  }

  async chat(request: ChatRequest): Promise<string> {
    const system = request.jsonSchema
      ? `${request.system}\n\nRéponds uniquement par un objet JSON conforme à ce schéma, sans texte autour :\n${JSON.stringify(request.jsonSchema)}`
      : request.system;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: request.maxTokens ? Math.max(request.maxTokens * 4, 4000) : 16000,
        system,
        messages: [{ role: 'user', content: request.prompt }],
        output_config: { effort: request.light ? 'low' : 'medium' },
        // En cas de refus du modèle principal, l'API route vers un modèle de repli.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as any);
      if (request.onToken) stream.on('text', request.onToken);
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new RefusedError('refusal');
      return message.content.map((block: { type: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : '')).join('').trim();
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('Clé API Claude invalide.');
      if (error instanceof Anthropic.RateLimitError) throw new Error('Limite de débit de l’API Claude atteinte, réessayez dans un instant.');
      if (error instanceof Anthropic.APIConnectionError) throw new Error('Impossible de joindre l’API Claude.');
      if (error instanceof Anthropic.APIError) throw new Error(`Erreur de l’API Claude (${error.status}).`);
      throw error;
    }
  }
}

// ---------- Moteurs factices (tests automatisés, sans modèle) ----------

/** Vectorisation déterministe par hachage de mots : suffisante pour tester la chaîne complète. */
export class FakeEmbedder implements Embedder {
  constructor(private readonly dim = 1024) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(this.dim);
      const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? [];
      for (const word of words) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
        v[Math.abs(h) % this.dim] += 1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export class FakeChat implements ChatProvider {
  readonly label = 'Modèle de test';
  async chat(request: ChatRequest): Promise<string> {
    let answer: string;
    if (request.jsonSchema) {
      const props = (request.jsonSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
      const obj: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(props)) obj[key] = def.type === 'array' ? ['Général'] : key === 'intent' ? 'question' : 'Résumé de test.';
      answer = JSON.stringify(obj);
    } else if (request.prompt.includes('[1]')) {
      answer = 'Réponse de test fondée sur les extraits fournis [1].';
    } else {
      answer = 'Réponse de test issue des connaissances générales du modèle.';
    }
    request.onToken?.(answer);
    return answer;
  }
}
