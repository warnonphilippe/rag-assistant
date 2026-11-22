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
  templateUrl: './chat.html',
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
