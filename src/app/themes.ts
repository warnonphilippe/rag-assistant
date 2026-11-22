import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { Icon } from './icon';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-themes',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './themes.html',
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
