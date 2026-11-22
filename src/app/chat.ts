import { ChangeDetectionStrategy, Component, ElementRef, Injectable, computed, effect, inject, signal, viewChild } from '@angular/core';
import type { ChatMessage, Conversation } from '../../shared/types';
import { Api } from './api';
import { Icon } from './icon';
import { I18n, TPipe } from './i18n';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rendu minimal du texte du modèle : paragraphes, listes, gras, code, renvois [n]. */
export function renderAnswer(text: string): string {
  const inline = (line: string) => escapeHtml(line)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>');
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { list.push(inline(item[1])); continue; }
    flush();
    if (!line) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    out.push(heading ? `<p><strong>${inline(heading[1])}</strong></p>` : `<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

/** État du dialogue, partagé entre la barre latérale et la vue. */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly api = inject(Api);
  readonly conversations = signal<Conversation[]>([]);
  readonly current = signal<number | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly draft = signal('');
  readonly busy = signal(false);
  readonly streaming = signal('');
  readonly pendingQuestion = signal('');

  constructor() { void this.loadConversations(); }

  async loadConversations() {
    this.conversations.set(await this.api.call('chat:conversations'));
  }

  async open(id: number | null) {
    this.current.set(id);
    this.messages.set(id === null ? [] : await this.api.call('chat:messages', { conversationId: id }));
  }

  async remove(id: number) {
    await this.api.call('chat:remove', { conversationId: id });
    if (this.current() === id) await this.open(null);
    await this.loadConversations();
  }

  async send() {
    const text = this.draft().trim();
    if (!text || this.busy()) return;
    const requestId = crypto.randomUUID();
    this.pendingQuestion.set(text);
    this.draft.set('');
    this.streaming.set('');
    this.busy.set(true);
    const stop = this.api.onTokens(requestId, (token) => this.streaming.update((s) => s + token));
    try {
      const result = await this.api.call('chat:send', { conversationId: this.current(), text, categoryId: this.api.chatCategory(), requestId });
      this.current.set(result.conversationId);
      this.messages.set(await this.api.call('chat:messages', { conversationId: result.conversationId }));
      await this.loadConversations();
    } catch (error) {
      this.draft.set(text);
      this.api.fail(error);
    } finally {
      stop();
      this.busy.set(false);
      this.streaming.set('');
    }
  }
}

@Component({
  selector: 'app-chat',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="chat-head">
      <h1>{{ title() }}</h1>
      <label class="pill-select">
        <app-icon name="themes" [size]="14" />
        <span class="sr-only">{{ 'chat.themeFilter' | t }}</span>
        <select [value]="api.chatCategory() ?? ''" (change)="setCategory($any($event.target).value)" data-testid="chat-theme">
          <option value="">{{ 'chat.allThemes' | t }}</option>
          @for (c of api.flatCategories(); track c.id) {
            <option [value]="c.id">{{ '— '.repeat(c.depth) + c.name }}</option>
          }
        </select>
      </label>
      <span class="muted small">{{ 'chat.sources' | t: { n: api.status()?.sources?.total ?? 0 } }}</span>
    </header>

    <div class="chat-scroll" #scroll>
      <div class="chat-col">
        @if (!messages().length && !busy()) {
          <div class="empty-state">
            <h2>{{ 'chat.emptyTitle' | t }}</h2>
            <p>{{ 'chat.emptyText' | t }}</p>
            @if (!(api.status()?.sources?.total)) {
              <p class="muted">{{ 'chat.emptyNoSources' | t }}</p>
              <button class="btn" (click)="api.view.set('library')">{{ 'chat.goLibrary' | t }}</button>
            }
          </div>
        }
        @for (m of messages(); track m.id) {
          @if (m.role === 'user') {
            <div class="bubble-user">{{ m.content }}</div>
          } @else {
            <article class="answer" [class.answer-warn]="m.kind === 'model'" [attr.data-kind]="m.kind">
              @switch (m.kind) {
                @case ('grounded') { <div class="answer-tag"><app-icon name="check" [size]="14" />{{ 'chat.grounded' | t }}</div> }
                @case ('documents') { <div class="answer-tag"><app-icon name="list" [size]="14" />{{ m.content }}</div> }
                @case ('model') { <div class="banner-warn"><app-icon name="info" [size]="15" />{{ 'chat.model' | t }}</div> }
                @case ('refused') { <div class="answer-tag tag-muted"><app-icon name="block" [size]="14" />{{ 'chat.refused' | t }}</div> }
                @case ('empty') { <div class="answer-tag tag-muted"><app-icon name="info" [size]="14" />{{ 'chat.empty' | t }}</div> }
              }
              @if (m.kind !== 'documents') { <div class="answer-body" [innerHTML]="render(m.content)"></div> }
              @if (m.citations.length) {
                <div class="cite-grid">
                  @for (c of m.citations; track c.n) {
                    <button class="cite-card" (click)="openSource()" [title]="c.excerpt">
                      <span class="cite-meta">[{{ c.n }}] {{ (c.kind === 'link' ? 'kind.link' : 'kind.file') | t }} · {{ c.section }}</span>
                      <span class="cite-title">{{ c.docTitle }}</span>
                      <span class="cite-excerpt">{{ c.excerpt }}</span>
                    </button>
                  }
                </div>
              }
              @if (m.documents.length) {
                @for (d of m.documents; track d.docId) {
                  <button class="doc-hit" (click)="openSource()">
                    <app-icon [name]="d.kind === 'link' ? 'link' : 'file'" [size]="18" />
                    <span class="doc-hit-text">
                      <span class="doc-hit-title">{{ d.title }}</span>
                      <span class="muted small">{{ d.section }} — {{ d.excerpt }}</span>
                    </span>
                    @for (c of d.categories.slice(0, 2); track c) { <span class="tag">{{ c }}</span> }
                  </button>
                }
              }
              @if (m.kind === 'model') { <div class="muted small">{{ 'chat.modelSource' | t: { engine: m.engine ?? '' } }}</div> }
            </article>
          }
        }
        @if (busy()) {
          <div class="bubble-user">{{ pendingQuestion() }}</div>
          <article class="answer" aria-live="polite">
            @if (streaming()) { <div class="answer-body" [innerHTML]="render(streaming())"></div> }
            @else { <div class="muted thinking">{{ 'chat.thinking' | t }}</div> }
          </article>
        }
      </div>
    </div>

    <div class="composer-wrap">
      <form class="composer" (submit)="$event.preventDefault(); send()">
        <label for="question" class="sr-only">{{ 'chat.question' | t }}</label>
        <textarea id="question" rows="1" #box [placeholder]="'chat.placeholder' | t" [value]="draft()" [disabled]="busy()"
          (input)="draft.set($any($event.target).value)" (keydown.enter)="onEnter($event)" data-testid="chat-input"></textarea>
        <button type="submit" class="btn-send" [attr.aria-label]="'chat.send' | t" [disabled]="busy() || !draft().trim()" data-testid="chat-send">
          <app-icon name="send" [size]="18" />
        </button>
      </form>
      <div class="composer-hint">{{ 'chat.hint' | t }}</div>
    </div>
  `,
})
export class ChatView {
  readonly api = inject(Api);
  readonly chat = inject(ChatStore);
  private readonly i18n = inject(I18n);
  private readonly scroll = viewChild<ElementRef<HTMLElement>>('scroll');

  readonly messages = this.chat.messages;
  readonly draft = this.chat.draft;
  readonly busy = this.chat.busy;
  readonly streaming = this.chat.streaming;
  readonly pendingQuestion = this.chat.pendingQuestion;
  readonly title = computed(() => this.chat.conversations().find((c) => c.id === this.chat.current())?.title ?? this.i18n.t('chat.newTitle'));

  constructor() {
    effect(() => {
      this.messages(); this.streaming(); this.busy();
      queueMicrotask(() => { const el = this.scroll()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; });
    });
  }

  render = renderAnswer;
  setCategory(value: string) { this.api.chatCategory.set(value ? Number(value) : null); }
  openSource() { this.api.view.set('library'); }
  send() { void this.chat.send(); }

  onEnter(event: Event) {
    if ((event as KeyboardEvent).shiftKey) return;
    event.preventDefault();
    this.send();
  }
}
