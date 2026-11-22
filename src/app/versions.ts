import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import type { MergeChoices, VersionAction } from '../../shared/types';
import { Api } from './api';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-version-dialog',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pending(); as p) {
      <div class="overlay">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="version-title" data-testid="version-dialog">
          <header class="dialog-head">
            <div class="eyebrow">{{ 'ver.eyebrow' | t }}</div>
            <h1 id="version-title">{{ 'ver.title' | t }}</h1>
            <p>{{ 'ver.intro' | t }}</p>
          </header>

          <div class="pair">
            <div class="pair-card">
              <div class="pair-label">{{ 'ver.existing' | t }}</div>
              <div class="pair-title">{{ p.oldDoc.title }}</div>
              <div class="muted small">{{ p.oldDoc.format.toUpperCase() }} · {{ 'ver.indexed' | t: { date: i18n.date(p.oldDoc.indexedAt) } }} · {{ 'ver.sections' | t: { n: p.oldDoc.sections } }}</div>
            </div>
            <div class="pair-card pair-new">
              <div class="pair-label">{{ 'ver.imported' | t }}</div>
              <div class="pair-title">{{ p.newDoc.title }}</div>
              <div class="small">{{ p.newDoc.format.toUpperCase() }} · {{ 'ver.sections' | t: { n: p.newDoc.sections } }}</div>
            </div>
          </div>

          <div class="stats">
            <div class="stat"><div class="stat-value" data-testid="cov-old">{{ pct(p.coverageOld) }} %</div><div class="small">{{ 'ver.covOld' | t }}</div></div>
            <div class="stat"><div class="stat-value">{{ pct(p.coverageNew) }} %</div><div class="small">{{ 'ver.covNew' | t }}</div></div>
            <div class="stat"><div class="stat-value" data-testid="verdict">{{ ('ver.verdict.' + p.verdict) | t }}</div><div class="small">{{ ('ver.diag.' + p.verdict) | t }}</div></div>
          </div>

          <section>
            <h2>{{ 'ver.compare' | t }}</h2>
            <div class="table-wrap">
              <table class="table table-compact">
                <thead><tr><th>{{ 'ver.colSection' | t }}</th><th>{{ 'ver.colDiff' | t }}</th><th>{{ 'ver.colMerge' | t }}</th></tr></thead>
                <tbody>
                  @for (s of p.sections; track $index) {
                    <tr>
                      <td class="strong" [class.struck]="s.diff === 'removed'">{{ s.title }}</td>
                      <td><span class="diff" [class]="'diff diff-' + s.diff">{{ ('ver.' + s.diff) | t }}</span></td>
                      <td>
                        @switch (s.diff) {
                          @case ('unchanged') { <span class="muted">{{ 'ver.kept' | t }}</span> }
                          @case ('modified') {
                            <select class="select" [attr.aria-label]="'ver.choice' | t: { title: s.title }" (change)="choose($index, $any($event.target).value)">
                              <option value="new">{{ 'ver.keepNew' | t }}</option><option value="old">{{ 'ver.keepOld' | t }}</option>
                            </select>
                          }
                          @case ('added') {
                            <select class="select" [attr.aria-label]="'ver.choice' | t: { title: s.title }" (change)="choose($index, $any($event.target).value)">
                              <option value="new">{{ 'ver.add' | t }}</option><option value="drop">{{ 'ver.skip' | t }}</option>
                            </select>
                          }
                          @case ('removed') {
                            <select class="select" [attr.aria-label]="'ver.choice' | t: { title: s.title }" (change)="choose($index, $any($event.target).value)">
                              <option value="drop">{{ 'ver.drop' | t }}</option><option value="keep">{{ 'ver.keep' | t }}</option>
                            </select>
                          }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <footer class="dialog-foot">
            <div class="muted small grow">{{ 'ver.note' | t }}</div>
            <button class="btn btn-quiet" (click)="api.versionDialog.set(null)">{{ 'ver.later' | t }}</button>
            <button class="btn btn-quiet" (click)="decide('discard')" [disabled]="busy()">{{ 'ver.discard' | t }}</button>
            <button class="btn" (click)="decide('keep-both')" [disabled]="busy()" data-testid="keep-both">{{ 'ver.keepBoth' | t }}</button>
            <button class="btn btn-outline" (click)="decide('merge')" [disabled]="busy()" data-testid="merge">{{ 'ver.merge' | t }}</button>
            <button class="btn btn-primary" (click)="decide('replace')" [disabled]="busy()" data-testid="replace">{{ 'ver.replace' | t }}</button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class VersionDialog {
  readonly api = inject(Api);
  readonly i18n = inject(I18n);
  readonly busy = signal(false);
  readonly choices = signal<MergeChoices>({});
  readonly pending = computed(() => this.api.pending().find((p) => p.id === this.api.versionDialog()) ?? null);

  constructor() {
    effect(() => { this.api.versionDialog(); this.choices.set({}); });
  }

  pct(value: number) { return Math.round(value * 100); }
  choose(index: number, value: 'new' | 'old' | 'keep' | 'drop') { this.choices.update((c) => ({ ...c, [index]: value })); }

  async decide(action: VersionAction) {
    const p = this.pending();
    if (!p) return;
    this.busy.set(true);
    try {
      await this.api.call('versions:decide', { id: p.id, action, choices: action === 'merge' ? this.choices() : undefined });
      this.api.versionDialog.set(null);
      await this.api.refresh();
    } catch (e) { this.api.fail(e); } finally { this.busy.set(false); }
  }
}
