import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { SourceDoc } from '../../shared/types';
import { Api } from './api';
import { Icon } from './icon';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-library',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library.html',
})
export class LibraryView {
  readonly api = inject(Api);
  readonly i18n = inject(I18n);

  readonly kinds = [{ value: 'all', label: 'lib.all' }, { value: 'file', label: 'lib.files' }, { value: 'link', label: 'lib.links' }] as const;
  readonly kind = signal<'all' | 'file' | 'link'>('all');
  readonly query = signal('');
  readonly over = signal(false);
  readonly linkOpen = signal(false);
  readonly linkUrl = signal('');
  readonly adding = signal(false);
  readonly checking = signal(false);
  readonly editing = signal<SourceDoc | null>(null);
  readonly selected = signal(new Set<number>());

  readonly counts = computed(() => this.api.status()?.sources ?? { total: 0, files: 0, links: 0 });
  readonly changed = computed(() => this.api.sources().filter((s) => s.linkState === 'changed' && s.status === 'ready'));
  readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.api.sources().filter((s) => (this.kind() === 'all' || s.kind === this.kind()) && (!q || s.title.toLowerCase().includes(q)));
  });

  pct(s: SourceDoc) { return Math.round((s.progress ?? 0.05) * 100); }

  async pick() {
    try { this.api.reportImport(await this.api.call('sources:pickFiles')); } catch (e) { this.api.fail(e); }
  }

  async drop(event: DragEvent) {
    event.preventDefault();
    this.over.set(false);
    const paths = Array.from(event.dataTransfer?.files ?? []).map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    try { this.api.reportImport(await this.api.call('sources:importPaths', { paths })); } catch (e) { this.api.fail(e); }
  }

  async addLink() {
    this.adding.set(true);
    try {
      const result = await this.api.call('sources:addLink', { url: this.linkUrl().trim() });
      this.api.reportImport(result);
      if (result.imported) { this.linkUrl.set(''); this.linkOpen.set(false); }
    } catch (e) { this.api.fail(e); } finally { this.adding.set(false); }
  }

  async checkLinks() {
    this.checking.set(true);
    try { await this.api.call('links:check'); await this.api.refresh(); } catch (e) { this.api.fail(e); } finally { this.checking.set(false); }
  }

  async reindex(s: SourceDoc) {
    try { await this.api.call('sources:reindex', { id: s.id }); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }

  async reindexChanged() { for (const s of this.changed()) await this.reindex(s); }

  async remove(s: SourceDoc) {
    if (!confirm(this.i18n.t('act.removeConfirm', { title: s.title }))) return;
    try { await this.api.call('sources:remove', { id: s.id }); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }

  review(s: SourceDoc) {
    const pending = this.api.pending().find((p) => p.newDoc.id === s.id);
    if (pending) this.api.versionDialog.set(pending.id);
  }

  editThemes(s: SourceDoc) {
    this.selected.set(new Set(s.categories.map((c) => c.id)));
    this.editing.set(s);
  }

  toggle(id: number) {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  async saveThemes(doc: SourceDoc) {
    try {
      await this.api.call('sources:setCategories', { id: doc.id, categoryIds: [...this.selected()] });
      this.editing.set(null);
      await this.api.refresh();
    } catch (e) { this.api.fail(e); }
  }
}
