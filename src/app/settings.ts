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
  template: `
    @if (api.settings(); as s) {
      <div class="settings">
        <h1>{{ 'set.title' | t }}</h1>

        <section class="panel">
          <h2>{{ 'set.engine' | t }}</h2>
          <label class="option" [class.option-on]="s.engine === 'local'">
            <input type="radio" name="engine" [checked]="s.engine === 'local'" (change)="set({ engine: 'local' })" data-testid="engine-local" />
            <span class="option-text">
              <span class="strong">{{ 'set.local' | t }} <span class="muted regular">· {{ 'set.localTag' | t }}</span></span>
              <span class="small">{{ 'set.localText' | t }}</span>
            </span>
          </label>
          <div class="option" [class.option-on]="s.engine === 'claude'">
            <input type="radio" name="engine" id="engine-claude" [checked]="s.engine === 'claude'" [disabled]="!s.hasClaudeKey" (change)="set({ engine: 'claude' })" data-testid="engine-claude" />
            <div class="option-text">
              <label for="engine-claude" class="strong">{{ 'set.claude' | t }} <span class="muted regular">· {{ 'set.claudeTag' | t }}</span></label>
              <span class="small">{{ 'set.claudeText' | t }}</span>
              <div class="row">
                <input type="password" class="input grow" autocomplete="off" [attr.aria-label]="'set.claudeKey' | t"
                  [placeholder]="(s.hasClaudeKey ? 'set.keySaved' : 'set.keyPlaceholder') | t" [value]="claudeKey()" (input)="claudeKey.set($any($event.target).value)" data-testid="claude-key" />
                <button class="btn" (click)="saveSecret('claudeKey', claudeKey())" [disabled]="!claudeKey().trim()" data-testid="claude-save">{{ 'set.save' | t }}</button>
                @if (s.hasClaudeKey) { <button class="btn btn-quiet" (click)="saveSecret('claudeKey', '')">{{ 'set.clear' | t }}</button> }
              </div>
              <span class="muted xsmall">{{ (s.hasClaudeKey ? 'set.keyNote' : 'set.needKey') | t }}</span>
              <div class="row">
                <label for="claude-model" class="grow">{{ 'set.claudeModel' | t }}</label>
                <select id="claude-model" class="select" [value]="s.claudeModel" (change)="set({ claudeModel: $any($event.target).value })">
                  @for (m of models; track m.id) { <option [value]="m.id" [selected]="m.id === s.claudeModel">{{ m.label }}</option> }
                </select>
              </div>
            </div>
          </div>
        </section>

        @if (api.status()?.models?.length) {
          <section class="panel">
            <h2>{{ 'set.models' | t }}</h2>
            @for (m of api.status()!.models; track m.id) {
              <div class="row line">
                <div class="grow">
                  <div class="strong">{{ m.label }}</div>
                  <div class="muted small">
                    @if (m.installed) { {{ 'set.installed' | t }} }
                    @else if (m.downloading) { {{ 'set.downloading' | t: { pct: pct(m.progress) } }} }
                    @else { {{ 'set.missing' | t: { size: m.sizeGb } }} }
                    @if (m.error) { · {{ m.error }} }
                  </div>
                </div>
                @if (m.installed) { <span class="tag">{{ 'nav.ready' | t }}</span> }
              </div>
            }
            @if (missing()) { <div><button class="btn btn-primary" (click)="download()" [disabled]="downloading()">{{ 'set.download' | t }}</button></div> }
          </section>
        }

        <section class="panel">
          <h2>{{ 'set.links' | t }}</h2>
          <div class="row">
            <label for="period" class="grow"><span class="strong block">{{ 'set.check' | t }}</span><span class="muted small">{{ 'set.checkText' | t }}</span></label>
            <select id="period" class="select" (change)="set({ refreshDays: +$any($event.target).value })" data-testid="refresh-days">
              @for (p of periods; track p.days) { <option [value]="p.days" [selected]="p.days === s.refreshDays">{{ p.label | t }}</option> }
            </select>
          </div>
          <label class="row line">
            <span class="grow"><span class="strong block">{{ 'set.auto' | t }}</span><span class="muted small">{{ 'set.autoText' | t }}</span></span>
            <input type="checkbox" class="check" [checked]="s.autoReindex" (change)="set({ autoReindex: $any($event.target).checked })" />
          </label>
          <div class="line stack">
            <div><span class="strong">{{ 'set.confluence' | t }}</span> <span class="muted">· {{ 'set.optional' | t }}</span><div class="muted small">{{ 'set.confluenceText' | t }}</div></div>
            <div class="grid3">
              <input type="url" class="input" [attr.aria-label]="'set.confluenceUrl' | t" [placeholder]="'set.confluenceUrl' | t" [value]="s.confluenceBaseUrl" (change)="set({ confluenceBaseUrl: $any($event.target).value.trim() })" />
              <input type="text" class="input" autocomplete="off" [attr.aria-label]="'set.confluenceUser' | t" [placeholder]="'set.confluenceUser' | t" [value]="s.confluenceUser" (change)="set({ confluenceUser: $any($event.target).value.trim() })" />
              <input type="password" class="input" autocomplete="off" [attr.aria-label]="'set.confluenceToken' | t" [placeholder]="(s.hasConfluenceToken ? 'set.tokenSaved' : 'set.confluenceToken') | t"
                (change)="saveSecret('confluenceToken', $any($event.target).value); $any($event.target).value = ''" />
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>{{ 'set.general' | t }}</h2>
          <div class="row">
            <label for="language" class="grow strong">{{ 'set.language' | t }}</label>
            <select id="language" class="select" (change)="set({ language: $any($event.target).value })" data-testid="language">
              <option value="fr" [selected]="s.language === 'fr'">Français</option>
              <option value="en" [selected]="s.language === 'en'">English</option>
            </select>
          </div>
          <div class="row line">
            <div class="grow"><div class="strong">{{ 'set.library' | t }}</div><div class="muted small url">{{ s.libraryDir }}</div></div>
            <button class="btn" (click)="pickDir()">{{ 'set.change' | t }}</button>
          </div>
          <label class="row line">
            <span class="grow"><span class="strong block">{{ 'set.pii' | t }}</span><span class="muted small">{{ 'set.piiText' | t }}</span></span>
            <input type="checkbox" class="check" [checked]="s.maskPii" (change)="set({ maskPii: $any($event.target).checked })" />
          </label>
        </section>
      </div>
    }
  `,
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
