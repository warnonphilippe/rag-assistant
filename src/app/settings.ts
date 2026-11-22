import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AppSettings } from '../../shared/types';
import { Api } from './api';
import { TPipe } from './i18n';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

@Component({
  selector: 'app-settings',
  imports: [TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
})
export class SettingsView {
  readonly api = inject(Api);
  readonly models = CLAUDE_MODELS;
  readonly periods = [{ days: 1, label: 'set.daily' }, { days: 7, label: 'set.weekly' }, { days: 30, label: 'set.monthly' }, { days: 0, label: 'set.never' }];
  readonly claudeKey = signal('');

  pct(value: number) { return Math.round(value * 100); }
  missing() { return this.api.status()?.models.some((m) => !m.installed) ?? false; }
  downloading() { return this.api.status()?.models.some((m) => m.downloading) ?? false; }

  async set(patch: Partial<AppSettings>) {
    try { await this.api.call('settings:set', patch as never); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }

  async saveSecret(name: 'claudeKey' | 'confluenceToken', value: string) {
    try {
      const settings = await this.api.call('settings:setSecret', { name, value });
      if (name === 'claudeKey') {
        this.claudeKey.set('');
        if (!settings.hasClaudeKey && settings.engine === 'claude') await this.api.call('settings:set', { engine: 'local' });
      }
      await this.api.refresh();
    } catch (e) { this.api.fail(e); }
  }

  async pickDir() {
    try { await this.api.call('settings:pickLibraryDir'); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }

  async download() {
    try { await this.api.call('models:download'); await this.api.refresh(); } catch (e) { this.api.fail(e); }
  }
}
