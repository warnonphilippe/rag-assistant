import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  AppEvent, AppSettings, AppStatus, CategoryNode, ImportResult, IpcChannel, IpcContract, PendingVersion, RendererApi, SourceDoc,
} from '../../shared/types';
import { I18n } from './i18n';

declare global {
  interface Window { api: RendererApi }
}

export type View = 'chat' | 'library' | 'themes' | 'settings';

/** État partagé de l'interface et accès au processus principal. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly i18n = inject(I18n);

  readonly view = signal<View>('chat');
  readonly status = signal<AppStatus | null>(null);
  readonly sources = signal<SourceDoc[]>([]);
  readonly categories = signal<CategoryNode[]>([]);
  readonly pending = signal<PendingVersion[]>([]);
  readonly settings = signal<AppSettings | null>(null);
  /** Thème sur lequel porte le dialogue (null = tous). */
  readonly chatCategory = signal<number | null>(null);
  /** Décision de version affichée (identifiant), ou null. */
  readonly versionDialog = signal<number | null>(null);
  readonly toast = signal<{ text: string; error: boolean } | null>(null);

  readonly flatCategories = computed(() => {
    const out: { id: number; name: string; depth: number }[] = [];
    const walk = (nodes: CategoryNode[], depth: number) => nodes.forEach((n) => { out.push({ id: n.id, name: n.name, depth }); walk(n.children, depth + 1); });
    walk(this.categories(), 0);
    return out;
  });

  private tokenListeners = new Map<string, (text: string) => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    window.api.onEvent((event: AppEvent) => {
      if (event.type === 'token') this.tokenListeners.get(event.requestId)?.(event.text);
      else this.scheduleRefresh();
    });
    void this.refresh();
  }

  call<C extends IpcChannel>(channel: C, payload?: IpcContract[C][0]): Promise<IpcContract[C][1]> {
    return window.api.invoke(channel, payload);
  }

  onTokens(requestId: string, listener: (text: string) => void): () => void {
    this.tokenListeners.set(requestId, listener);
    return () => this.tokenListeners.delete(requestId);
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, 150);
  }

  async refresh() {
    const [status, sources, categories, pending, settings] = await Promise.all([
      this.call('app:status'), this.call('sources:list'), this.call('categories:tree'), this.call('versions:pending'), this.call('settings:get'),
    ]);
    const known = new Set(this.pending().map((p) => p.id));
    this.status.set(status);
    this.sources.set(sources);
    this.categories.set(categories);
    this.pending.set(pending);
    this.settings.set(settings);
    this.i18n.lang.set(settings.language);
    document.documentElement.lang = settings.language;
    // Une nouvelle proposition de version s'ouvre d'elle-même.
    const fresh = pending.find((p) => !known.has(p.id));
    if (fresh && this.versionDialog() === null) this.versionDialog.set(fresh.id);
    if (this.versionDialog() !== null && !pending.some((p) => p.id === this.versionDialog())) this.versionDialog.set(null);
  }

  notify(text: string, error = false) {
    this.toast.set({ text, error });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), error ? 9000 : 5000);
  }

  fail(error: unknown) {
    const detail = String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    this.notify(this.i18n.t('common.error', { detail }), true);
  }

  reportImport(result: ImportResult) {
    const parts: string[] = [];
    if (result.imported) parts.push(this.i18n.t('import.done', { n: result.imported }));
    if (result.duplicates.length) parts.push(this.i18n.t('import.duplicates', { names: result.duplicates.join(', ') }));
    if (result.errors.length) parts.push(this.i18n.t('import.errors', { names: result.errors.map((e) => `${e.name} (${e.message})`).join(', ') }));
    if (parts.length) this.notify(parts.join(' '), result.errors.length > 0);
    void this.refresh();
  }
}
