
"use strict";
const obsidian = require("obsidian");
const { Plugin, ItemView, WorkspaceLeaf, Notice, Modal, Setting, requestUrl, MarkdownRenderer } = obsidian;

const VIEW_TYPE = "atlas-cowork-view";

const DEFAULT_SETTINGS = {
  endpoint: "http://100.127.175.36:18083/v1",
  model: "deepseek-v4.1-flash-weightless",
  maxTokens: 1800,
  temperature: 0.6,
  systemPrompt: "Ты участник рабочей команды и помогаешь с проектом. Отвечай по-русски, кратко и по делу. Если не знаешь — честно скажи. Не выдумывай факты, ссылки и числа.",
};

function truncate(s, n) { return s.length > n ? s.slice(0, n) + "\n…[обрезано]" : s; }

function extractJson(text) {
  if (!text) throw new Error("empty response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  return JSON.parse(raw);
}

class BrainstormModal extends Modal {
  constructor(app, onSubmit) { super(app); this.onSubmit = onSubmit; this.value = ""; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Брейншторм на канвасе" });
    const input = contentEl.createEl("textarea", { attr: { rows: "3", style: "width:100%" } });
    input.placeholder = "Тема или вопрос для брейншторма";
    input.focus();
    const btn = contentEl.createEl("button", { text: "Сгенерировать", cls: "mod-cta" });
    btn.style.marginTop = "10px";
    btn.onclick = () => { const v = input.value.trim(); if (v) { this.close(); this.onSubmit(v); } };
  }
  onClose() { this.contentEl.empty(); }
}

class AtlasView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.rendering = false; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Atlas"; }
  getIcon() { return "sparkles"; }

  async onOpen() { this.renderAll(); }

  renderAll() {
    const root = this.contentEl;
    root.empty();
    root.addClass("atlas-cowork");

    const header = root.createDiv({ cls: "atlas-header" });
    header.createSpan({ text: "Atlas", cls: "atlas-title" });
    const ctx = header.createSpan({ cls: "atlas-context" });
    const file = this.app.workspace.getActiveFile();
    ctx.setText(file ? "контекст: " + file.basename : "контекст: весь проект");
    const clear = header.createEl("button", { text: "Очистить", cls: "atlas-mini" });
    clear.onclick = () => { this.plugin.messages = []; this.renderAll(); };

    const list = root.createDiv({ cls: "atlas-messages" });
    for (const m of this.plugin.messages) {
      const row = list.createDiv({ cls: "atlas-msg atlas-" + m.role });
      const bubble = row.createDiv({ cls: "atlas-bubble" });
      if (m.role === "assistant") {
        MarkdownRenderer.render(this.app, m.content || "", bubble, "", this).catch(() => bubble.setText(m.content || ""));
        const actions = row.createDiv({ cls: "atlas-actions" });
        const append = actions.createEl("button", { text: "В заметку", cls: "atlas-mini" });
        append.onclick = () => this.appendToNote(m.content);
        const save = actions.createEl("button", { text: "Новая заметка", cls: "atlas-mini" });
        save.onclick = () => this.saveAsNote(m.content);
      } else {
        bubble.setText(m.content);
      }
    }

    const composer = root.createDiv({ cls: "atlas-composer" });
    const input = composer.createEl("textarea", { attr: { rows: "3", placeholder: "Спроси про проект… Enter — отправить, Shift+Enter — новая строка" } });
    const send = composer.createEl("button", { text: "Спросить", cls: "mod-cta" });
    const submit = () => { const v = input.value.trim(); if (v) { input.value = ""; this.send(v); } };
    send.onclick = submit;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 0);
    this.scrollBottom();
  }

  scrollBottom() { const el = this.contentEl.querySelector(".atlas-messages"); if (el) el.scrollTop = el.scrollHeight; }

  async buildContext() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return "";
    let text = "";
    try { text = await this.app.vault.read(file); } catch (e) {}
    const ed = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    const sel = ed ? ed.getSelection() : "";
    return "Текущая заметка: " + file.path + "\n\n" + truncate(text, 12000) + (sel ? "\n\nВыделение:\n" + sel : "");
  }

  async send(text) {
    if (this.rendering) return;
    this.plugin.messages.push({ role: "user", content: text });
    this.renderAll();
    this.rendering = true;
    const list = this.contentEl.querySelector(".atlas-messages");
    const thinking = list.createDiv({ cls: "atlas-msg atlas-assistant" });
    thinking.createDiv({ cls: "atlas-bubble atlas-thinking", text: "Атлас думает…" });
    this.scrollBottom();
    try {
      const ctx = await this.buildContext();
      const msgs = [];
      if (ctx) msgs.push({ role: "system", content: "Контекст проекта:\n" + ctx });
      for (const m of this.plugin.messages) msgs.push({ role: m.role, content: m.content });
      const answer = await this.plugin.chat(msgs);
      this.plugin.messages.push({ role: "assistant", content: answer });
    } catch (e) {
      this.plugin.messages.push({ role: "assistant", content: "Ошибка: " + (e && e.message ? e.message : e) });
    } finally {
      this.rendering = false;
      this.renderAll();
    }
  }

  async appendToNote(text) {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("Нет открытой заметки"); return; }
    await this.app.vault.append(file, "\n\n" + text + "\n");
    new Notice("Добавлено в " + file.basename);
  }

  async saveAsNote(text) {
    const dir = "Projects/Pilot/AI";
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    const name = "atlas-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".md";
    const p = dir + "/" + name;
    await this.app.vault.create(p, text);
    await this.app.workspace.openLinkText(p, "", false);
  }
}

class AtlasCoworkPlugin extends Plugin {
  async onload() {
    this.messages = [];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new AtlasView(leaf, this));
    this.addRibbonIcon("sparkles", "Atlas Cowork", () => this.activateView());
    this.addCommand({ id: "open-atlas-cowork", name: "Открыть чат Atlas", callback: () => this.activateView() });
    this.addCommand({ id: "atlas-brainstorm-canvas", name: "Брейншторм на канвасе", callback: () => this.brainstorm() });
    this.addCommand({ id: "atlas-ask-selection", name: "Спросить Atlas о выделении", callback: () => this.askSelection() });
    this.addSettingTab(new AtlasSettingTab(this.app, this));
  }
  onunload() {}

  async activateView() {
    let leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async askSelection() {
    const ed = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    const sel = ed ? ed.getSelection() : "";
    await this.activateView();
    if (sel) { const view = this.getView(); if (view) view.send("Объясни и разбери этот фрагмент:\n\n" + sel); }
  }

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  async chat(messages, opts) {
    opts = opts || {};
    const body = {
      model: this.settings.model,
      messages: [{ role: "system", content: this.settings.systemPrompt }].concat(messages),
      max_tokens: opts.maxTokens || this.settings.maxTokens,
      temperature: opts.temperature === undefined ? this.settings.temperature : opts.temperature,
    };
    const res = await requestUrl({ url: this.settings.endpoint.replace(/\/$/, "") + "/chat/completions", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status >= 400) throw new Error("Atlas HTTP " + res.status + ": " + (res.text || "").slice(0, 200));
    const data = res.json;
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    return (msg && (msg.content || msg.reasoning)) || "";
  }

  async brainstorm() {
    new BrainstormModal(this.app, (topic) => this.brainstormTopic(topic)).open();
  }

  async brainstormTopic(topic) {
    {
      const notice = new Notice("Atlas собирает идеи…", 0);
      try {
        const prompt = "Проведи брейншторм по теме: " + topic + "\nВерни СТРОГО JSON без пояснений: {\"cards\":[{\"text\":\"идея\"}]}. 8–12 карточек, каждая — короткая конкретная мысль.";
        const raw = await this.chat([{ role: "user", content: prompt }], { maxTokens: 2500, temperature: 0.9 });
        const data = extractJson(raw);
        const cards = (data.cards || []).slice(0, 16);
        if (!cards.length) throw new Error("Atlas не вернул карточки");
        const nodes = cards.map((c, i) => ({
          id: "n" + i, type: "text", text: String(c.text || ""),
          x: (i % 3) * 340, y: Math.floor(i / 3) * 220, width: 300, height: 140,
        }));
        const canvas = { nodes, edges: [] };
        const dir = "Projects/Pilot";
        const path = dir + "/brainstorm-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".canvas";
        await this.app.vault.create(path, JSON.stringify(canvas, null, 2));
        await this.app.workspace.openLinkText(path, "", false);
        notice.hide();
        new Notice("Готово: " + cards.length + " идей");
      } catch (e) {
        notice.hide();
        new Notice("Ошибка брейншторма: " + (e && e.message ? e.message : e));
        throw e;
      }
    }
  }
}

class AtlasSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Atlas Cowork" });
    new Setting(containerEl).setName("Endpoint").addText(t => t.setValue(this.plugin.settings.endpoint).onChange(async v => { this.plugin.settings.endpoint = v.trim(); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(containerEl).setName("Модель").addText(t => t.setValue(this.plugin.settings.model).onChange(async v => { this.plugin.settings.model = v.trim(); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(containerEl).setName("Max tokens").addText(t => t.setValue(String(this.plugin.settings.maxTokens)).onChange(async v => { const n = parseInt(v, 10); if (!isNaN(n)) { this.plugin.settings.maxTokens = n; await this.plugin.saveData(this.plugin.settings); } }));
    new Setting(containerEl).setName("Системный промпт").addTextArea(t => t.setValue(this.plugin.settings.systemPrompt).onChange(async v => { this.plugin.settings.systemPrompt = v; await this.plugin.saveData(this.plugin.settings); }));
  }
}

module.exports = AtlasCoworkPlugin;
