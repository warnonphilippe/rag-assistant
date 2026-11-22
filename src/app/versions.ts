import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import type { MergeChoices, VersionAction } from '../../shared/types';
import { Api } from './api';
import { I18n, TPipe } from './i18n';

@Component({
  selector: 'app-version-dialog',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './versions.html',
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
