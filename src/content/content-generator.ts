/**
 * Generic Content Generator
 *
 * Provides a unified approach for generating all content types in NotebookLM Studio.
 * This class reuses existing patterns from ContentManager and stealth utilities
 * to interact with the NotebookLM UI reliably.
 *
 * Key features:
 * - Generic content generation flow that works for all content types
 * - Button discovery with multiple fallback selectors
 * - Chat-based fallback when Studio buttons are not available
 * - Streaming-aware response waiting
 *
 * This is the foundation for Phase 1 content types:
 * - audio_overview, video, infographic, report, presentation, data_table
 */

import type { Page } from 'patchright';
import { randomDelay, humanType } from '../utils/stealth-utils.js';
import {
  waitForLatestAnswer,
  snapshotAllResponses,
  snapshotAnswerTexts,
  isErrorMessage,
} from '../utils/page-utils.js';
import { log } from '../utils/logger.js';
import { t } from '../i18n/index.js';
import type { ContentType, ContentGenerationInput, ContentGenerationResult } from './types.js';
import { type ContentTypeConfig, getContentConfig, buildChatPrompt } from './content-templates.js';

/**
 * Result of finding a button in the UI
 */
interface ButtonFindResult {
  found: boolean;
  selector?: string;
}

/**
 * Result of waiting for content generation
 */
interface ContentWaitResult {
  source: 'studio' | 'chat';
  content?: string;
  ready: boolean;
  error?: string;
}

/**
 * Generic Content Generator for NotebookLM Studio
 *
 * This class provides a unified content generation flow that:
 * 1. Navigates to the Studio panel
 * 2. Checks if content already exists
 * 3. Finds and clicks the generation button
 * 4. Falls back to chat-based generation if needed
 * 5. Waits for content completion with streaming detection
 */
export class ContentGenerator {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Generate content of any supported type
   *
   * @param input Content generation input with type and options
   * @returns Content generation result
   */
  async generate(input: ContentGenerationInput): Promise<ContentGenerationResult> {
    const config = getContentConfig(input.type);

    if (!config) {
      return {
        success: false,
        contentType: input.type,
        error: `Unsupported content type: ${input.type}`,
      };
    }

    log.info(`Generating ${config.displayName}...`);
    let languageWarning: string | undefined;

    try {
      // Step 1: Navigate to Studio panel
      await this.navigateToStudio();
      await this.page.waitForTimeout(1000);

      // Step 2: Check if content already exists
      const exists = await this.checkContentExists(config);
      if (exists) {
        log.info(`  ${config.displayName} already exists`);
        return {
          success: true,
          contentType: input.type,
          status: 'ready',
        };
      }

      // Step 3: Trigger generation via the Studio card.
      //
      // Post-rebrand flow (verified live 2026-07-30): Studio is a grid of
      // generation cards. Clicking a card either generates directly
      // (audio_overview) or opens a "Créer un X" dialog of format-preset tiles
      // — clicking a preset starts generation. Completion is signalled by a new
      // `<artifact-library-item>` appearing in the Studio library, regardless
      // of type. We snapshot the artifact count first so we can detect exactly
      // the one this call produces.
      const baselineArtifacts = await this.countArtifacts();

      const buttonResult = await this.findButton(config.buttonSelectors);

      if (buttonResult.found && buttonResult.selector) {
        log.info(`  Found ${config.displayName} card: ${buttonResult.selector}`);

        // Force-click past the hover tooltip that overlays Studio cards and
        // intercepts pointer events (a normal click times out at 30s).
        await this.page.mouse.move(0, 0).catch(() => undefined);
        await this.page
          .locator(buttonResult.selector)
          .first()
          .click({ force: true, timeout: 15000 });
        log.info(`  Clicked ${config.displayName} card`);

        // If a language was asked for, generation has to go through the
        // customisation panel — that is the only place NotebookLM exposes a
        // language menu, and it sits one level deeper than the format tiles.
        // Falls back to the plain preset click when the panel is not offered.
        const customised = input.language
          ? await this.configureViaCustomize(input)
          : { languageSet: false, started: false };
        if (input.language && !customised.languageSet) {
          languageWarning =
            `NotebookLM's ${config.displayName} dialog offers no language menu, so the ` +
            `content was generated in the account's default language, not "${input.language}". ` +
            `The RPC transport (the default) can set the language for this type.`;
        }

        // If a format-preset dialog opened, pick a preset to start generation.
        // Audio has no dialog (generates directly), so this is a no-op there.
        if (!customised.started) await this.selectArtifactPreset(config);

        log.info(`  Started ${config.displayName} generation via Studio`);

        // Wait for a NEW artifact to appear in the Studio library.
        const waitResult = await this.waitForArtifact(baselineArtifacts, config);

        if (waitResult.ready) {
          log.success(`  ${config.displayName} generated successfully via Studio`);
          if (languageWarning) log.warning(`  ${languageWarning}`);
          return {
            success: true,
            contentType: input.type,
            status: 'ready',
            textContent: waitResult.content,
            ...(languageWarning ? { warnings: [languageWarning] } : {}),
          };
        } else if (waitResult.error) {
          log.error(`  ${config.displayName} generation failed: ${waitResult.error}`);
          return {
            success: false,
            contentType: input.type,
            status: 'failed',
            error: waitResult.error,
          };
        }
      }

      // Step 4: Fallback to chat-based generation
      log.info(`  No Studio button found, trying chat-based approach...`);
      return await this.generateViaChatFallback(input, config);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Content generation failed: ${errorMsg}`);
      return {
        success: false,
        contentType: input.type,
        error: errorMsg,
      };
    }
  }

  // ============================================================================
  // Navigation Methods (reused from ContentManager patterns)
  // ============================================================================

  /**
   * Navigate to the Studio panel in NotebookLM
   * Uses the same approach as ContentManager.navigateToStudio()
   */
  async navigateToStudio(): Promise<void> {
    // Updated selectors based on current NotebookLM UI (Dec 2024)
    // The tabs are: Sources | Discussion | Studio
    const studioSelectors = [
      'div.mdc-tab:has-text("Studio")', // Material Design tab with text
      '.mat-mdc-tab:has-text("Studio")', // Angular Material tab
      '[role="tab"]:has-text("Studio")', // Tab role with Studio text
      'div.mdc-tab >> text=Studio', // Playwright text selector
      '.notebook-guide', // Legacy fallback
    ];

    for (const selector of studioSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          // Check if already selected
          const isActive =
            (await el.getAttribute('aria-selected')) === 'true' ||
            (await el.getAttribute('class'))?.includes('mdc-tab--active');

          if (!isActive) {
            await el.click();
            await randomDelay(800, 1200);
            log.info(`  Clicked Studio tab`);
          } else {
            log.info(`  Studio tab already active`);
          }
          return;
        }
      } catch {
        continue;
      }
    }

    // Try clicking by finding the tab list and clicking the third tab
    try {
      const tabList = this.page.locator('.mat-mdc-tab-list .mdc-tab').nth(2); // Studio is 3rd tab (0-indexed)
      if (await tabList.isVisible({ timeout: 1000 })) {
        await tabList.click();
        await randomDelay(800, 1200);
        log.info(`  Studio tab accessed via tab list`);
        return;
      }
    } catch {
      // Continue to fallback
    }

    log.warning(`  Could not find Studio tab, content generation may fail`);
  }

  /**
   * Navigate to the Discussion panel (chat)
   * Uses the same approach as ContentManager.navigateToDiscussion()
   */
  private async navigateToDiscussion(): Promise<void> {
    const discussionSelectors = [
      'div.mdc-tab:has-text("Discussion")',
      '.mat-mdc-tab:has-text("Discussion")',
      '[role="tab"]:has-text("Discussion")',
      'div.mdc-tab >> text=Discussion',
    ];

    for (const selector of discussionSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          // Check if already selected
          const isActive =
            (await el.getAttribute('aria-selected')) === 'true' ||
            (await el.getAttribute('class'))?.includes('mdc-tab--active');

          if (!isActive) {
            await el.click();
            await randomDelay(500, 800);
            log.info(`  Clicked Discussion tab`);
          } else {
            log.info(`  Discussion tab already active`);
          }
          return;
        }
      } catch {
        continue;
      }
    }

    // Discussion might already be active or accessible
    log.info(`  Discussion panel should be accessible`);
  }

  // ============================================================================
  // Button Discovery
  // ============================================================================

  /**
   * Find a button using multiple selectors
   * Tries each selector in order and returns the first visible match
   *
   * @param selectors Array of CSS selectors to try
   * @returns Result with found status and matching selector
   */
  async findButton(selectors: string[]): Promise<ButtonFindResult> {
    for (const selector of selectors) {
      try {
        const button = this.page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) {
          return { found: true, selector };
        }
      } catch {
        continue;
      }
    }

    return { found: false };
  }

  // ============================================================================
  // Studio artifact flow (post "Gemini Notebook" rebrand)
  // ============================================================================

  /** Count generated artifacts currently in the Studio library. */
  private async countArtifacts(): Promise<number> {
    return await this.page
      .locator('artifact-library artifact-library-item')
      .count()
      .catch(() => 0);
  }

  /**
   * After clicking a Studio card, some content types (report, presentation,
   * video, infographic, data_table) open a "Créer un X" dialog whose format
   * tiles are `button.primary-action-button[aria-label="…"]`; clicking a tile
   * starts generation. Audio has no dialog (generates directly) so this no-ops.
   * We skip the "Créer le vôtre" / "Create your own" customiser and pick the
   * first ready-made preset.
   */
  /**
   * Generate through the customisation panel so the output language can be set.
   *
   * The format dialog itself has no language control — captured live on
   * 2026-08-21, it holds only preset tiles and a Generate button. The language
   * menu lives behind each tile's pencil ("Customize") button, alongside a
   * free-text description field. Until this existed, the `language` argument
   * simply never reached the browser path, and generation reported success on
   * content in the wrong language (#36).
   *
   * Anchored on locale-independent handles wherever possible: the pencil is
   * matched by its `edit` mat-icon ligature and the menu by `role="combobox"`,
   * so this does not break when the UI is driven in French or Japanese.
   * Returns false — leaving the caller to take the ordinary preset path — the
   * moment any step is missing, because generating in the wrong language is
   * better than not generating at all, and the caller is told either way.
   */
  private async configureViaCustomize(
    input: ContentGenerationInput
  ): Promise<{ languageSet: boolean; started: boolean }> {
    const nothingDone = { languageSet: false, started: false };
    const wanted = input.language?.trim();
    if (!wanted) return nothingDone;
    try {
      // Two dialog shapes, captured live on 2026-08-21. Audio and Video open
      // straight onto their customisation panel, language menu included.
      // Reports open on format tiles instead, and hide the menu behind each
      // tile's pencil. So: use the menu if it is already here, and only go
      // looking for a pencil if it is not.
      // Generous first wait: these dialogs have been measured taking upwards of
      // ten seconds to render, and a short timeout here does not report "no
      // language menu" — it manufactures one, then generates in the wrong
      // language and says so wrongly.
      let combo = this.page.locator('[role="combobox"]').first();
      if (!(await combo.isVisible({ timeout: 15000 }).catch(() => false))) {
        const pencil = this.page.locator('button:has(mat-icon:has-text("edit"))').first();
        if (!(await pencil.isVisible({ timeout: 5000 }).catch(() => false))) {
          log.warning('  This dialog offers no language menu — leaving the language unset');
          return nothingDone;
        }
        await this.page.mouse.move(0, 0).catch(() => undefined);
        await pencil.click({ force: true, timeout: 10000 });
        await randomDelay(1500, 2500);
        combo = this.page.locator('[role="combobox"]').first();
        if (!(await combo.isVisible({ timeout: 4000 }).catch(() => false))) {
          log.warning('  Customisation panel has no language menu');
          return nothingDone;
        }
      }
      await this.page.mouse.move(0, 0).catch(() => undefined);
      await combo.click({ force: true, timeout: 10000 });
      await randomDelay(1200, 2000);

      if (!(await this.pickLanguageOption(wanted))) return nothingDone;
      log.success(`  Output language set to ${wanted}`);

      if (input.customInstructions) {
        const box = this.page.locator('textarea').first();
        if (await box.isVisible({ timeout: 2000 }).catch(() => false)) {
          await box.fill(input.customInstructions).catch(() => undefined);
        }
      }

      // Scoped to the dialog. Searched page-wide, this matched a stray button
      // behind the overlay and reported "no generate button" on a panel that
      // plainly had one — while the language had in fact been set, so the
      // caller was warned about a failure that had not happened.
      const generateLabel = t('buttons', 'generate');
      const generate = this.page
        .locator('.cdk-overlay-container')
        .locator(
          `button:has-text("${generateLabel}"), button:has-text("Generate"), button:has-text("Générer")`
        )
        .last();
      if (!(await generate.isVisible({ timeout: 5000 }).catch(() => false))) {
        // The language is set either way; the ordinary preset path will start
        // generation. Nothing to warn about.
        log.info('  No generate button in the panel — the preset flow will start generation');
        return { languageSet: true, started: false };
      }
      await generate.click({ force: true, timeout: 10000 });
      log.success(`  Generating in ${wanted} via the customisation panel`);
      return { languageSet: true, started: true };
    } catch (error) {
      log.warning(`  Customisation flow failed (${(error as Error).message}); using presets`);
      return nothingDone;
    }
  }

  /**
   * Click the language option whose text is the one asked for.
   *
   * Matched on the option's own text rather than a `:has-text()` substring,
   * which would take "Español" for "Español (Latinoamérica)" whenever that
   * happened to come first. English is the exception the menu itself creates:
   * it renders as "English (default)", so a prefix match is allowed when the
   * option merely extends the wanted name with a parenthesis.
   */
  private async pickLanguageOption(wanted: string): Promise<boolean> {
    const options = await this.page.locator('[role="option"]').all();
    if (options.length === 0) {
      log.warning('  Language menu opened but listed nothing');
      return false;
    }
    const norm = (v: string) => v.trim().toLowerCase().normalize('NFC');
    const target = norm(wanted);

    let prefixMatch: (typeof options)[number] | null = null;
    for (const option of options) {
      const text = norm((await option.innerText().catch(() => '')) || '');
      if (!text) continue;
      if (text === target) {
        await option.click({ force: true, timeout: 8000 });
        await randomDelay(800, 1400);
        return true;
      }
      if (!prefixMatch && text.startsWith(`${target} (`)) prefixMatch = option;
    }
    if (prefixMatch) {
      await prefixMatch.click({ force: true, timeout: 8000 });
      await randomDelay(800, 1400);
      return true;
    }
    log.warning(`  "${wanted}" is not in NotebookLM's language menu (${options.length} listed)`);
    return false;
  }

  private async selectArtifactPreset(config: ContentTypeConfig): Promise<void> {
    const anyPreset = this.page.locator('button.primary-action-button').first();
    if (!(await anyPreset.isVisible({ timeout: 4000 }).catch(() => false))) {
      // No preset tiles. Some types (e.g. video) instead open a
      // "Personnaliser le X" customization dialog with a dedicated
      // "Générer"/"Generate" button and sensible pre-selected defaults — click
      // it. If neither exists, the type generates directly on the card click
      // (e.g. audio), so there is nothing more to do.
      const generateBtn = this.page
        .locator(
          'mat-dialog-container button:has-text("Générer"), mat-dialog-container button:has-text("Generate"), [role="dialog"] button:has-text("Générer"), [role="dialog"] button:has-text("Generate")'
        )
        .first();
      if (await generateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await this.page.mouse.move(0, 0).catch(() => undefined);
        await generateBtn.click({ force: true, timeout: 10000 }).catch(() => undefined);
        log.info(`  Clicked "Générer" in ${config.displayName} customization dialog`);
      }
      return; // direct-generation type or customization dialog handled
    }
    const buttons = await this.page.locator('button.primary-action-button').all();
    for (const b of buttons) {
      const aria = (await b.getAttribute('aria-label').catch(() => '')) || '';
      if (!aria) continue;
      // Skip the custom-report builder — it opens a form, not a direct generate.
      if (/créer le vôtre|create your own|personnalis|eigene erstellen|カスタム/i.test(aria)) {
        continue;
      }
      await this.page.mouse.move(0, 0).catch(() => undefined);
      await b.click({ force: true, timeout: 10000 }).catch(() => undefined);
      log.info(`  Selected ${config.displayName} preset: ${aria}`);
      return;
    }
    // Fallback: second tile (index 0 is usually the customiser).
    if (buttons.length > 1) {
      await buttons[1].click({ force: true, timeout: 10000 }).catch(() => undefined);
    }
  }

  /**
   * Wait for a NEW artifact to appear in the Studio library after triggering
   * generation. Post-rebrand, every completed artifact renders as an
   * `<artifact-library-item>` (title in `.artifact-title`), so a count above
   * the pre-trigger baseline is the universal completion signal — replacing the
   * per-type `existsSelectors`, which the rebrand invalidated.
   */
  private async waitForArtifact(
    baseline: number,
    config: ContentTypeConfig
  ): Promise<ContentWaitResult> {
    log.info(
      `  Waiting for ${config.displayName} artifact (up to ${config.waitTimeout / 60000} min)...`
    );
    const startTime = Date.now();
    while (Date.now() - startTime < config.waitTimeout) {
      const count = await this.countArtifacts();
      if (count > baseline) {
        // The item is inserted immediately with a placeholder title
        // ("Création du rapport…" / "Génération…") and only later resolves to
        // the real title + a `.artifact-details` line ("Briefing Doc · N
        // sources · …"). So `count > baseline` alone fires too early — wait
        // until the newest item is no longer in its generating state.
        const item = this.page.locator('artifact-library artifact-library-item').first();
        const title = (
          (await item
            .locator('.artifact-title')
            .first()
            .textContent()
            .catch(() => '')) || ''
        ).trim();
        const details = (
          (await item
            .locator('.artifact-details')
            .first()
            .textContent()
            .catch(() => '')) || ''
        ).trim();
        const stillGenerating =
          !details || /création|génération|creating|generating|作成中|生成中/i.test(title);
        if (!stillGenerating) {
          return { source: 'studio', ready: true, content: title || undefined };
        }
      }
      const errorEl = await this.page.$('.error-message, [role="alert"]:has-text("error")');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        return {
          source: 'studio',
          ready: false,
          error: errorText || `${config.displayName} generation failed`,
        };
      }
      await this.page.waitForTimeout(3000);
    }
    return {
      source: 'studio',
      ready: false,
      error: `Timeout waiting for ${config.displayName} generation after ${config.waitTimeout / 1000}s`,
    };
  }

  // ============================================================================
  // Content Existence Check
  // ============================================================================

  /**
   * Check if content of the specified type already exists
   *
   * @param config Content type configuration
   * @returns True if content exists
   */
  private async checkContentExists(config: ContentTypeConfig): Promise<boolean> {
    for (const selector of config.existsSelectors) {
      try {
        const element = this.page.locator(selector).first();
        if (await element.isVisible({ timeout: 500 })) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  // ============================================================================
  // Content Generation Waiting
  // ============================================================================

  /**
   * Wait for content generation to complete
   * Monitors the UI for completion indicators or errors
   *
   * @param type Content type being generated
   * @param config Content type configuration
   * @returns Wait result with status and optional content
   */
  async waitForContentGeneration(
    _type: ContentType,
    config: ContentTypeConfig
  ): Promise<ContentWaitResult> {
    log.info(
      `  Waiting for ${config.displayName} generation (up to ${config.waitTimeout / 60000} minutes)...`
    );

    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds

    while (Date.now() - startTime < config.waitTimeout) {
      // Check for errors
      const errorEl = await this.page.$('.error-message, [role="alert"]:has-text("error")');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        return {
          source: 'studio',
          ready: false,
          error: errorText || `${config.displayName} generation failed`,
        };
      }

      // Check if content now exists
      const exists = await this.checkContentExists(config);
      if (exists) {
        return {
          source: 'studio',
          ready: true,
        };
      }

      // Check for progress indicators
      const progressEl = await this.page.$('[role="progressbar"], .progress-bar, .loading');
      if (progressEl) {
        const progress = await progressEl.getAttribute('aria-valuenow');
        if (progress) {
          log.info(`  Generation progress: ${progress}%`);
        }
      }

      await this.page.waitForTimeout(pollInterval);
    }

    return {
      source: 'studio',
      ready: false,
      error: `Timeout waiting for ${config.displayName} generation after ${config.waitTimeout / 1000}s`,
    };
  }

  // ============================================================================
  // Chat-Based Fallback
  // ============================================================================

  /**
   * Generate content using chat-based fallback when Studio button is not available
   *
   * @param input Content generation input
   * @param config Content type configuration
   * @returns Content generation result
   */
  private async generateViaChatFallback(
    input: ContentGenerationInput,
    config: ContentTypeConfig
  ): Promise<ContentGenerationResult> {
    try {
      // Navigate to Discussion panel
      await this.navigateToDiscussion();

      // Build the prompt with format and custom instructions
      // Pass the full input so format options are included in the prompt
      const prompt = buildChatPrompt(config, input);

      // Position baseline for new-answer detection — captured before the
      // message is sent, so the container that appears afterward is
      // unambiguously the new answer even if its text repeats a prior one.
      const baselineCounts = await snapshotAnswerTexts(this.page);

      // Send the chat message
      await this.sendChatMessage(prompt);

      // Wait for response using the proven page-utils approach
      const result = await this.waitForChatResponse(config, baselineCounts);

      if (result.ready && result.content) {
        log.success(`  ${config.displayName} generated via chat fallback`);
        return {
          success: true,
          contentType: input.type,
          status: 'ready',
          textContent: result.content,
        };
      }

      return {
        success: false,
        contentType: input.type,
        status: 'failed',
        error: result.error || `Failed to generate ${config.displayName} via chat`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        contentType: input.type,
        error: `Chat fallback failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Send a message in the chat interface
   * Uses the same approach as ContentManager.sendChatMessage()
   *
   * @param message Message to send
   */
  private async sendChatMessage(message: string): Promise<void> {
    log.info(`  Sending chat message: "${message.substring(0, 50)}..."`);

    // Dismiss any overlays
    try {
      await this.page.keyboard.press('Escape').catch(() => {});
      await randomDelay(200, 300);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        if (!doc) return;
        doc.querySelectorAll('.cdk-overlay-backdrop').forEach((b: any) => b.click?.());
        doc.querySelectorAll('button[aria-label="Close"], button[aria-label="Fechar"], button[aria-label="Cerrar"]').forEach((b: any) => b.click?.());
      }).catch(() => {});
      await randomDelay(200, 300);
    } catch {}

    // Find the chat input (same approach as BrowserSession.findChatInput)
    const chatInputSelectors = [
      'textarea.query-box-input', // PRIMARY - same as Python implementation
      'textarea[aria-label*="query"]',
      'textarea[aria-label*="Zone de requete"]',
      'textarea[aria-label*="Feld für"]',
      'textarea[aria-label*="Caja"]',
      'textarea[aria-label*="Perguntar"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="question"]',
    ];

    let inputSelector: string | null = null;
    for (const selector of chatInputSelectors) {
      try {
        const input = await this.page.waitForSelector(selector, {
          state: 'visible',
          timeout: 3000,
        });
        if (input) {
          inputSelector = selector;
          log.info(`  Found chat input: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!inputSelector) {
      throw new Error('Chat input not found');
    }

    // Clear any existing text first
    const inputEl = await this.page.$(inputSelector);
    if (inputEl) {
      try {
        await this.page.keyboard.press('Escape').catch(() => {});
        await randomDelay(200, 300);
        // Try to remove any overlay
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.page.evaluate(() => {
          const doc: any = (globalThis as any).document;
          if (!doc) return;
          const overlays = doc.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-container .mat-mdc-dialog-container, .mat-dialog-container');
          overlays.forEach((o: any) => o.click?.());
        }).catch(() => {});
        await randomDelay(200, 300);
        await inputEl.click({ timeout: 5000 });
      } catch {
        try {
          await inputEl.click({ force: true, timeout: 5000 });
        } catch {
          // last resort
          await this.page.click(inputSelector, { force: true, timeout: 5000 });
        }
      }
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Backspace');
      await randomDelay(200, 400);
    }

    // Type the message with human-like behavior
    log.info(`  Typing message with human-like behavior...`);
    await humanType(this.page, inputSelector, message, {
      withTypos: false, // No typos for prompts to avoid confusion
      wpm: 150, // Faster typing for long prompts
    });

    // Small pause before submitting
    await randomDelay(500, 1000);

    // Submit with Enter key
    log.info(`  Submitting message...`);
    await this.page.keyboard.press('Enter');

    // Small pause after submit
    await randomDelay(1000, 1500);

    log.info(`  Message sent`);
  }

  /**
   * Wait for chat response with streaming detection
   * Uses the proven waitForLatestAnswer from page-utils
   *
   * @param config Content type configuration
   * @returns Wait result with content
   */
  private async waitForChatResponse(
    config: ContentTypeConfig,
    baselineCounts: Map<number, number>
  ): Promise<ContentWaitResult> {
    log.info(
      `  Waiting for ${config.displayName} response (up to ${config.waitTimeout / 60000} minutes)...`
    );

    // Scroll to bottom to ensure we see all messages
    await this.scrollChatToBottom();

    // Snapshot existing chat responses (debug/logging only — new-answer
    // detection uses the position baseline captured before the message was sent)
    const existingResponses = await snapshotAllResponses(this.page);
    log.info(`  Ignoring ${existingResponses.length} existing chat responses`);

    // Use the proven logic from page-utils
    const response = await waitForLatestAnswer(this.page, {
      question: '', // Empty question since we already sent the message
      timeoutMs: config.waitTimeout,
      pollIntervalMs: 2000, // Poll every 2 seconds
      ignoreTexts: existingResponses,
      baselineCounts,
      debug: true, // Enable debug to see what's happening
    });

    // Check if response is an error message from NotebookLM
    if (response && isErrorMessage(response)) {
      log.error(`  NotebookLM returned an error: "${response}"`);
      return {
        source: 'chat',
        ready: false,
        error: `NotebookLM error: ${response}`,
      };
    }

    if (response && response.length > 50) {
      log.success(`  Content received (${response.length} chars)`);
      return {
        source: 'chat',
        ready: true,
        content: response,
      };
    }

    return {
      source: 'chat',
      ready: false,
      error: `Timeout waiting for ${config.displayName} response`,
    };
  }

  /**
   * Scroll chat container to bottom to ensure latest messages are visible
   */
  private async scrollChatToBottom(): Promise<void> {
    try {
      // Try multiple selectors for the chat container
      const chatContainerSelectors = [
        '.chat-scroll-container',
        '.messages-container',
        '[class*="scroll"]',
        '.query-container',
      ];

      for (const selector of chatContainerSelectors) {
        const container = await this.page.$(selector);
        if (container) {
          await container.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          log.debug(`  Scrolled chat to bottom using ${selector}`);
          return;
        }
      }

      // Fallback: scroll the whole page
      await this.page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      log.debug(`  Scrolled page to bottom (fallback)`);
    } catch (error) {
      log.debug(`  Could not scroll: ${error}`);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a ContentGenerator instance for a page
 *
 * @param page Playwright page instance
 * @returns ContentGenerator instance
 */
export function createContentGenerator(page: Page): ContentGenerator {
  return new ContentGenerator(page);
}

// Note: CONTENT_CONFIGS, getContentConfig, buildChatPrompt, getFormatFromInput
// are exported from content-templates.ts and re-exported via index.ts
