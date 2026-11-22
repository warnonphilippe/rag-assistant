import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { SourceDoc } from '../../shared/types';
import { Api } from './api';
import { Icon } from './icon';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-library',
  imports: [Icon, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div class="grow">
        <h1>{{ 'lib.title' | t }}</h1>
        <div class="muted">{{ 'lib.count' | t: counts() }}</div>
      </div>
      <button class="btn" (click)="checkLinks()" [disabled]="checking()"><app-icon name="refresh" [size]="16" />{{ 'lib.checkLinks' | t }}</button>
      <button class="btn" (click)="linkOpen.set(true)" data-testid="add-link"><app-icon name="link" [size]="16" />{{ 'lib.addLink' | t }}</button>
      <button class="btn btn-primary" (click)="pick()" data-testid="import"><app-icon name="plus" [size]="16" />{{ 'lib.import' | t }}</button>
    </header>

    @if (linkOpen()) {
      <form class="inline-form" (submit)="$event.preventDefault(); addLink()">
        <label for="link-url" class="sr-only">{{ 'lib.linkUrl' | t }}</label>
        <input id="link-url" type="url" class="input grow" [placeholder]="'lib.linkPlaceholder' | t" [value]="linkUrl()" (input)="linkUrl.set($any($event.target).value)" data-testid="link-url" />
        <button type="submit" class="btn btn-primary" [disabled]="adding() || !linkUrl().trim()" data-testid="link-add">{{ 'lib.add' | t }}</button>
        <button type="button" class="btn" (click)="linkOpen.set(false)">{{ 'lib.cancel' | t }}</button>
      </form>
    }

    @if (api.pending().length; as n) {
      <div class="banner-warn banner-row" data-testid="pending-banner">
        <app-icon name="info" [size]="18" />
        <div class="grow"><strong>{{ (n > 1 ? 'lib.pendingMany' : 'lib.pendingOne') | t: { n } }}</strong></div>
        <button class="btn btn-warn" (click)="api.versionDialog.set(api.pending()[0].id)" data-testid="review">{{ 'lib.review' | t }}</button>
      </div>
    }
    @if (changed().length; as n) {
      <div class="banner-warn banner-row" data-testid="changed-banner">
        <app-icon name="refresh" [size]="18" />
        <div class="grow"><strong>{{ (n > 1 ? 'lib.changedMany' : 'lib.changedOne') | t: { n } }}</strong> {{ 'lib.changedText' | t }}</div>
        <button class="btn btn-warn" (click)="reindexChanged()">{{ 'lib.reindexAll' | t }}</button>
      </div>
    }

    <div class="dropzone" [class.dropzone-over]="over()" (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)" (drop)="drop($event)">
      <div class="drop-title">{{ 'lib.dropTitle' | t }}</div>
      <div class="small">{{ 'lib.dropText' | t }}</div>
    </div>

    <div class="filters">
      <label for="filter" class="sr-only">{{ 'lib.filterLabel' | t }}</label>
      <input id="filter" type="search" class="input grow" [placeholder]="'lib.filter' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
      @for (f of kinds; track f.value) {
        <button class="chip" [class.chip-on]="kind() === f.value" [attr.aria-pressed]="kind() === f.value" (click)="kind.set(f.value)">{{ f.label | t }}</button>
      }
    </div>

    @if (!api.sources().length) {
      <div class="empty-state"><p>{{ 'lib.empty' | t }}</p></div>
    } @else if (!shown().length) {
      <div class="empty-state"><p>{{ 'lib.noMatch' | t }}</p></div>
    } @else {
      <div class="table-wrap">
        <table class="table" data-testid="sources">
          <thead>
            <tr>
              <th>{{ 'lib.colSource' | t }}</th><th>{{ 'lib.colThemes' | t }}</th><th>{{ 'lib.colChunking' | t }}</th>
              <th>{{ 'lib.colIndexed' | t }}</th><th>{{ 'lib.colState' | t }}</th><th><span class="sr-only">{{ 'lib.colActions' | t }}</span></th>
            </tr>
          </thead>
          <tbody>
            @for (s of shown(); track s.id) {
              <tr [attr.data-status]="s.status">
                <td>
                  <div class="strong">{{ s.title }}</div>
                  <div class="muted small">
                    {{ s.kind === 'link' ? ('kind.link' | t) : s.format.toUpperCase() }}
                    @if (s.version > 1) { · {{ 'lib.version' | t: { n: s.version } }} }
                    @if (s.kind === 'link' && s.lastCheckedAt) { · {{ 'lib.checked' | t: { date: i18n.date(s.lastCheckedAt) } }} }
                  </div>
                  @if (s.kind === 'link') { <div class="muted small url">{{ s.url }}</div> }
                </td>
                <td>
                  <div class="tags">
                    @for (c of s.categories; track c.id) { <span class="tag">{{ c.name }}</span> }
                    <button class="icon-btn" (click)="editThemes(s)" [attr.aria-label]="'act.themes' | t" [title]="'act.themes' | t"><app-icon name="edit" [size]="14" /></button>
                  </div>
                </td>
                <td>{{ s.chunking ? (('chunk.' + s.chunking) | t) : '—' }}</td>
                <td>{{ i18n.date(s.indexedAt) }}</td>
                <td>
                  @if (s.status === 'indexing') {
                    <div class="progress-row">
                      <div class="progress" role="progressbar" [attr.aria-label]="'state.indexing' | t" [attr.aria-valuenow]="pct(s)" aria-valuemin="0" aria-valuemax="100"><div [style.width.%]="pct(s)"></div></div>
                      {{ 'state.indexing' | t }}
                    </div>
                  } @else if (s.status === 'error') {
                    <span class="state-error" [title]="s.error ?? ''">{{ 'state.error' | t }}</span>
                    <div class="muted small">{{ s.error }}</div>
                  } @else if (s.status === 'pending') {
                    <button class="link-warn" (click)="review(s)">{{ 'state.pending' | t }}</button>
                  } @else if (s.linkState === 'changed') {
                    <button class="link-warn" (click)="reindex(s)">{{ 'state.changed' | t }}</button>
                  } @else if (s.linkState === 'unreachable') {
                    <span class="state-error">{{ 'state.unreachable' | t }}</span>
                  } @else {
                    <span class="state-ok">{{ 'state.ready' | t }}</span>
                  }
                </td>
                <td class="row-actions">
                  <button class="icon-btn" (click)="reindex(s)" [disabled]="s.status === 'indexing'" [attr.aria-label]="'act.reindex' | t" [title]="'act.reindex' | t"><app-icon name="refresh" [size]="15" /></button>
                  <button class="icon-btn" (click)="remove(s)" [attr.aria-label]="'act.remove' | t" [title]="'act.remove' | t"><app-icon name="trash" [size]="15" /></button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    @if (editing(); as doc) {
      <div class="overlay" (click)="editing.set(null)">
        <div class="dialog dialog-small" role="dialog" aria-labelledby="themes-title" (click)="$event.stopPropagation()">
          <h2 id="themes-title">{{ 'themes.assign' | t: { title: doc.title } }}</h2>
          @if (!api.flatCategories().length) { <p class="muted">{{ 'themes.none' | t }}</p> }
          <div class="check-list">
            @for (c of api.flatCategories(); track c.id) {
              <label class="check-row" [style.padding-left.px]="8 + c.depth * 18">
                <input type="checkbox" [checked]="selected().has(c.id)" (change)="toggle(c.id)" />{{ c.name }}
              </label>
            }
          </div>
          <div class="dialog-actions">
            <button class="btn" (click)="editing.set(null)">{{ 'lib.cancel' | t }}</button>
            <button class="btn btn-primary" (click)="saveThemes(doc)">{{ 'themes.save' | t }}</button>
          </div>
        </div>
      </div>
    }
  `,
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
