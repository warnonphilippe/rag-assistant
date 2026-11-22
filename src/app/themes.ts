import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { Icon } from './icon';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-themes',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div class="grow">
        <h1>{{ 'themes.title' | t }}</h1>
        <div class="muted">{{ 'themes.intro' | t }}</div>
      </div>
      <button class="btn" (click)="create(null)" data-testid="new-theme"><app-icon name="plus" [size]="16" />{{ 'themes.new' | t }}</button>
    </header>

    <div class="themes-layout">
      <nav class="tree" [attr.aria-label]="'themes.tree' | t">
        <button class="tree-item" [class.tree-on]="selected() === 'all'" (click)="selected.set('all')">
          <span class="grow">{{ 'themes.all' | t }}</span><span class="count">{{ ready().length }}</span>
        </button>
        @for (c of api.flatCategories(); track c.id) {
          <button class="tree-item" [class.tree-on]="selected() === c.id" [style.padding-left.px]="12 + c.depth * 18" (click)="selected.set(c.id)">
            <span class="grow">{{ c.name }}</span><span class="count">{{ countFor(c.id) }}</span>
          </button>
        }
        <button class="tree-item tree-muted" [class.tree-on]="selected() === 'none'" (click)="selected.set('none')">
          <span class="grow">{{ 'themes.unclassified' | t }}</span><span class="count">{{ unclassified().length }}</span>
        </button>
      </nav>

      <section class="themes-main">
        <div class="section-head">
          <h2 class="grow">{{ title() }} <span class="muted h2-meta">· {{ 'themes.count' | t: { n: docs().length } }}</span></h2>
          @if (categoryId(); as id) {
            <button class="icon-btn" (click)="create(id)" [attr.aria-label]="'themes.newSub' | t" [title]="'themes.newSub' | t"><app-icon name="plus" [size]="15" /></button>
            <button class="icon-btn" (click)="rename(id)" [attr.aria-label]="'themes.rename' | t" [title]="'themes.rename' | t"><app-icon name="edit" [size]="15" /></button>
            <button class="icon-btn" (click)="remove(id)" [attr.aria-label]="'themes.delete' | t" [title]="'themes.delete' | t"><app-icon name="trash" [size]="15" /></button>
          }
          <button class="btn btn-primary" (click)="ask()" [disabled]="!docs().length"><app-icon name="chat" [size]="16" />{{ 'themes.ask' | t }}</button>
        </div>
        @if (!docs().length) {
          <div class="empty-state"><p>{{ 'themes.empty' | t }}</p></div>
        }
        <div class="card-grid">
          @for (d of docs(); track d.id) {
            <article class="card">
              <span class="card-meta">{{ d.kind === 'link' ? ('kind.link' | t) : d.format.toUpperCase() }}@for (c of d.categories; track c.id) { · {{ c.name }} }</span>
              <span class="card-title">{{ d.title }}</span>
              <span class="card-text">{{ d.summary }}</span>
            </article>
          }
        </div>
      </section>
    </div>

    @if (prompt(); as p) {
      <div class="overlay" (click)="prompt.set(null)">
        <form class="dialog dialog-small" role="dialog" aria-labelledby="theme-prompt" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); submit()">
          <h2 id="theme-prompt">{{ p.title }}</h2>
          <label for="theme-name" class="sr-only">{{ 'themes.name' | t }}</label>
          <input id="theme-name" class="input" maxlength="40" [placeholder]="'themes.name' | t" [value]="name()" (input)="name.set($any($event.target).value)" data-testid="theme-name" />
          <div class="dialog-actions">
            <button type="button" class="btn" (click)="prompt.set(null)">{{ 'lib.cancel' | t }}</button>
            <button type="submit" class="btn btn-primary" [disabled]="!name().trim()" data-testid="theme-save">{{ 'themes.save' | t }}</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class ThemesView {
  readonly api = inject(Api);
  private readonly i18n = inject(I18n);

  readonly selected = signal<number | 'all' | 'none'>('all');
  readonly prompt = signal<{ title: string; mode: 'create' | 'rename'; id: number | null } | null>(null);
  readonly name = signal('');

  readonly ready = computed(() => this.api.sources().filter((s) => s.status === 'ready' || s.status === 'indexing'));
  readonly unclassified = computed(() => this.ready().filter((s) => !s.categories.length));
  readonly categoryId = computed(() => (typeof this.selected() === 'number' ? (this.selected() as number) : null));

  /** Identifiants d'un thème et de tous ses sous-thèmes. */
  private subtree(id: number): Set<number> {
    const flat = this.api.flatCategories();
    const start = flat.findIndex((c) => c.id === id);
    const ids = new Set<number>();
    if (start < 0) return ids;
    ids.add(id);
    for (let i = start + 1; i < flat.length && flat[i].depth > flat[start].depth; i++) ids.add(flat[i].id);
    return ids;
  }

  countFor(id: number) { const ids = this.subtree(id); return this.ready().filter((s) => s.categories.some((c) => ids.has(c.id))).length; }

  readonly docs = computed(() => {
    const sel = this.selected();
    if (sel === 'all') return this.ready();
    if (sel === 'none') return this.unclassified();
    const ids = this.subtree(sel);
    return this.ready().filter((s) => s.categories.some((c) => ids.has(c.id)));
  });

  readonly title = computed(() => {
    const sel = this.selected();
    if (sel === 'all') return this.i18n.t('themes.all');
    if (sel === 'none') return this.i18n.t('themes.unclassified');
    return this.api.flatCategories().find((c) => c.id === sel)?.name ?? '';
  });

  ask() {
    this.api.chatCategory.set(this.categoryId());
    this.api.view.set('chat');
  }

  create(parentId: number | null) {
    this.name.set('');
    this.prompt.set({ title: this.i18n.t(parentId === null ? 'themes.new' : 'themes.newSub'), mode: 'create', id: parentId });
  }

  rename(id: number) {
    this.name.set(this.title());
    this.prompt.set({ title: this.i18n.t('themes.rename'), mode: 'rename', id });
  }

  async submit() {
    const p = this.prompt();
    if (!p) return;
    try {
      if (p.mode === 'create') await this.api.call('categories:create', { name: this.name().trim(), parentId: p.id });
      else await this.api.call('categories:rename', { id: p.id!, name: this.name().trim() });
      this.prompt.set(null);
      await this.api.refresh();
    } catch (e) { this.api.fail(e); }
  }

  async remove(id: number) {
    try {
      await this.api.call('categories:remove', { id });
      this.selected.set('all');
      await this.api.refresh();
    } catch (e) { this.api.fail(e); }
  }
}
