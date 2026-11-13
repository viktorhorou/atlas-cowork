
"use strict";
const obsidian = require("obsidian");
const { Plugin, ItemView, Notice, Modal, Setting, requestUrl, MarkdownRenderer } = obsidian;

const VIEW_TYPE = "atlas-cowork-view";

const DEFAULT_SETTINGS = {
  endpoint: "http://100.127.175.36:18083/v1",
  model: "deepseek-v4.1-flash-weightless",
  maxTokens: 2200,
  temperature: 0.6,
  systemPrompt: "Ты участник рабочей команды и помогаешь с проектом. Отвечай по-русски, кратко и по делу. Если не знаешь — честно скажи. Не выдумывай факты, ссылки и числа.",
  projectRoot: "Projects/Pilot",
  threadFolder: "Projects/Pilot/AI/threads",
  reviewFolder: "Projects/Pilot/AI/reviews",
  digestFolder: "Projects/Pilot/AI/digests",
  autoSaveThreads: true,
};

function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n) + "\n…[обрезано]" : s; }
function today() { return new Date().toISOString().slice(0, 10); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16); }

function extractJson(text) {
  if (!text) throw new Error("empty response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  return JSON.parse(raw);
}

class QuickAskModal extends Modal {
  constructor(app, plugin, initial) { super(app); this.plugin = plugin; this.initial = initial || ""; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Спросить Атласа" });
    const input = contentEl.createEl("textarea", { attr: { rows: "3", style: "width:100%" } });
    input.placeholder = "Вопрос по проекту или открытой заметке";
    input.value = this.initial;
    input.focus();
    const row = contentEl.createDiv({ style: "display:flex; gap:8px; margin-top:8px" });
    const ask = row.createEl("button", { text: "Спросить", cls: "mod-cta" });
    const status = contentEl.createDiv({ cls: "atlas-thinking", text: "" });
    const answer = contentEl.createDiv({ cls: "atlas-quick-answer" });
    ask.onclick = async () => {
      const q = input.value.trim(); if (!q) return;
      ask.disabled = true; status.setText("Атлас думает…"); answer.empty();
      try {
        const ctx = await this.plugin.projectContext(true);
        const msgs = [];
        if (ctx) msgs.push({ role: "system", content: "Контекст проекта:\n" + ctx });
        msgs.push({ role: "user", content: q });
        const reply = await this.plugin.chat(msgs);
        status.setText("");
        MarkdownRenderer.render(this.app, reply, answer, "", this).catch(() => answer.setText(reply));
        const actions = contentEl.createDiv({ style: "display:flex; gap:8px; margin-top:8px" });
        const toNote = actions.createEl("button", { text: "В заметку" });
        toNote.onclick = () => this.plugin.appendToActive(reply);
        const toThread = actions.createEl("button", { text: "В тред" });
        toThread.onclick = () => this.plugin.saveTurn(q, reply);
      } catch (e) { status.setText("Ошибка: " + (e.message || e)); }
      finally { ask.disabled = false; }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class AtlasView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.busy = false; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Atlas"; }
  getIcon() { return "sparkles"; }
  async onOpen() { this.renderAll(); }

  renderAll() {
    const root = this.contentEl; root.empty(); root.addClass("atlas-cowork");
    const header = root.createDiv({ cls: "atlas-header" });
    header.createSpan({ text: "Atlas", cls: "atlas-title" });
    const ctx = header.createSpan({ cls: "atlas-context" });
    ctx.setText(this.plugin.settings.projectRoot);
    const bar = root.createDiv({ cls: "atlas-toolbar" });
    const mk = (label, fn) => { const b = bar.createEl("button", { text: label, cls: "atlas-mini" }); b.onclick = fn; };
    mk("Дом", () => this.plugin.openProjectHome());
    mk("Дайджест", () => this.plugin.digest());
    mk("Ревью", () => this.plugin.reviewCurrent());
    mk("Новый тред", () => { this.plugin.messages = []; this.plugin.threadPath = null; this.renderAll(); });
    if (this.plugin.threadPath) { const b = bar.createEl("button", { text: "Тред", cls: "atlas-mini" }); b.onclick = () => this.plugin.openPath(this.plugin.threadPath); }

    const list = root.createDiv({ cls: "atlas-messages" });
    for (const m of this.plugin.messages) {
      const row = list.createDiv({ cls: "atlas-msg atlas-" + m.role });
      const bubble = row.createDiv({ cls: "atlas-bubble" });
      if (m.role === "assistant") {
        MarkdownRenderer.render(this.app, m.content || "", bubble, "", this).catch(() => bubble.setText(m.content || ""));
        const actions = row.createDiv({ cls: "atlas-actions" });
        const append = actions.createEl("button", { text: "В заметку", cls: "atlas-mini" });
        append.onclick = () => this.plugin.appendToActive(m.content);
        const save = actions.createEl("button", { text: "Новая заметка", cls: "atlas-mini" });
        save.onclick = () => this.plugin.saveAsNote(m.content);
      } else bubble.setText(m.content);
    }

    const composer = root.createDiv({ cls: "atlas-composer" });
    const input = composer.createEl("textarea", { attr: { rows: "3", placeholder: "Спроси про проект… Enter — отправить" } });
    const send = composer.createEl("button", { text: "Спросить", cls: "mod-cta" });
    const submit = () => { const v = input.value.trim(); if (v && !this.busy) { input.value = ""; this.send(v); } };
    send.onclick = submit;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 0);
    this.scrollBottom();
  }

  scrollBottom() { const el = this.contentEl.querySelector(".atlas-messages"); if (el) el.scrollTop = el.scrollHeight; }

  async send(text) {
    this.busy = true;
    this.plugin.messages.push({ role: "user", content: text });
    this.renderAll();
    const list = this.contentEl.querySelector(".atlas-messages");
    const thinking = list.createDiv({ cls: "atlas-msg atlas-assistant" });
    thinking.createDiv({ cls: "atlas-bubble atlas-thinking", text: "Атлас думает…" });
    this.scrollBottom();
    try {
      const ctx = await this.plugin.projectContext(true);
      const msgs = [];
      if (ctx) msgs.push({ role: "system", content: "Контекст проекта:\n" + ctx });
      for (const m of this.plugin.messages) msgs.push({ role: m.role, content: m.content });
      const answer = await this.plugin.chat(msgs);
      this.plugin.messages.push({ role: "assistant", content: answer });
      await this.plugin.saveTurn(text, answer);
    } catch (e) {
      this.plugin.messages.push({ role: "assistant", content: "Ошибка: " + (e.message || e) });
    } finally { this.busy = false; this.renderAll(); }
  }
}

class AtlasSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Atlas Cowork" });
    const add = (name, key, desc) => new Setting(containerEl).setName(name).setDesc(desc || "").addText(t => t.setValue(String(this.plugin.settings[key] || "")).onChange(async v => { this.plugin.settings[key] = v.trim(); await this.plugin.saveData(this.plugin.settings); }));
    add("Endpoint", "endpoint");
    add("Модель", "model");
    add("Проект", "projectRoot", "Папка проекта внутри vault");
    add("Треды", "threadFolder");
    add("Ревью", "reviewFolder");
    new Setting(containerEl).setName("Автосохранять треды").addToggle(t => t.setValue(!!this.plugin.settings.autoSaveThreads).onChange(async v => { this.plugin.settings.autoSaveThreads = v; await this.plugin.saveData(this.plugin.settings); }));
    new Setting(containerEl).setName("Системный промпт").addTextArea(t => t.setValue(this.plugin.settings.systemPrompt).onChange(async v => { this.plugin.settings.systemPrompt = v; await this.plugin.saveData(this.plugin.settings); }));
  }
}

class AtlasCoworkPlugin extends Plugin {
  async onload() {
    this.messages = [];
    this.threadPath = null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new AtlasView(leaf, this));
    this.addRibbonIcon("sparkles", "Atlas Cowork", () => this.activateView());
    this.addCommand({ id: "open-atlas-cowork", name: "Открыть чат Atlas", callback: () => this.activateView() });
    this.addCommand({ id: "atlas-quick-ask", name: "Быстрый вопрос Атласу", callback: () => new QuickAskModal(this.app, this).open() });
    this.addCommand({ id: "atlas-ask-selection", name: "Спросить Atlas о выделении", callback: () => this.askSelection() });
    this.addCommand({ id: "atlas-brainstorm-canvas", name: "Брейншторм на канвасе", callback: () => this.brainstorm() });
    this.addCommand({ id: "atlas-review", name: "Разобрать заметку (ревью)", callback: () => this.reviewCurrent() });
    this.addCommand({ id: "atlas-digest", name: "Дайджест проекта", callback: () => this.digest() });
    this.addCommand({ id: "atlas-project-home", name: "Открыть дом проекта", callback: () => this.openProjectHome() });
    this.addSettingTab(new AtlasSettingTab(this.app, this));
  }
  onunload() {}

  async activateView() {
    let leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  getView() { const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE); return leaves.length ? leaves[0].view : null; }

  async ensureFolder(path) {
    if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.createFolder(path);
  }
  async openPath(path) { await this.app.workspace.openLinkText(path, "", false); }
  async appendToActive(text) {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice("Нет открытой заметки"); return; }
    await this.app.vault.append(f, "\n\n" + text + "\n");
    new Notice("Добавлено в " + f.basename);
  }
  async saveAsNote(text) {
    const dir = this.settings.projectRoot + "/AI";
    await this.ensureFolder(dir);
    const p = dir + "/atlas-" + stamp() + ".md";
    await this.app.vault.create(p, text);
    await this.openPath(p);
  }

  async projectContext(includeActive) {
    const parts = [];
    const root = this.settings.projectRoot;
    const home = this.app.vault.getAbstractFileByPath(root + "/00 Дом проекта.md");
    if (home) { try { parts.push("Дом проекта:\n" + truncate(await this.app.vault.read(home), 6000)); } catch (e) {} }
    try {
      const files = this.app.vault.getFiles().filter(f => f.path.startsWith(root + "/"));
      const names = files.slice(0, 80).map(f => f.path.slice(root.length + 1));
      parts.push("Файлы проекта:\n" + names.join("\n"));
    } catch (e) {}
    if (includeActive) {
      const f = this.app.workspace.getActiveFile();
      if (f) {
        try { parts.push("Открытая заметка (" + f.path + "):\n" + truncate(await this.app.vault.read(f), 12000)); } catch (e) {}
        const ed = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
        const sel = ed ? ed.getSelection() : "";
        if (sel) parts.push("Выделение:\n" + sel);
      }
    }
    return parts.join("\n\n");
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
    const d = res.json; const m = d && d.choices && d.choices[0] && d.choices[0].message;
    return (m && (m.content || m.reasoning)) || "";
  }

  async saveTurn(question, answer) {
    if (!this.settings.autoSaveThreads) return;
    if (!this.threadPath) {
      await this.ensureFolder(this.settings.threadFolder);
      this.threadPath = this.settings.threadFolder + "/" + stamp() + ".md";
      await this.app.vault.create(this.threadPath, "---\nproject: " + this.settings.projectRoot + "\ncreated: " + new Date().toISOString() + "\n---\n\n# Тред\n");
      const v = this.getView(); if (v) v.renderAll();
    }
    const tf = this.app.vault.getAbstractFileByPath(this.threadPath);
    if (tf) await this.app.vault.append(tf, "\n### Ты\n" + question + "\n\n### Атлас\n" + answer + "\n");
  }

  async askSelection() {
    const ed = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    const sel = ed ? ed.getSelection() : "";
    if (!sel) { new Notice("Ничего не выделено"); return; }
    new QuickAskModal(this.app, this, "Разбери этот фрагмент:\n\n" + sel).open();
  }

  async reviewCurrent() {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice("Нет открытой заметки"); return; }
    const note = await this.app.vault.read(f);
    if (note.length < 20) { new Notice("Заметка слишком короткая"); return; }
    const prompt = "Сделай ревью заметки. Ищи: фактические риски, неточности, противоречия, пропущенные решения и следующие шаги. Верни СТРОГО JSON: {\"items\":[{\"kind\":\"риск|неточность|пропуск|предложение\",\"quote\":\"точная цитата из заметки\",\"issue\":\"в чём проблема\",\"suggestion\":\"что сделать\"}]}. 5–12 пунктов, без воды.\n\nЗаметка:\n" + note;
    const raw = await this.chat([{ role: "user", content: prompt }], { maxTokens: 3000, temperature: 0.3 });
    let data; try { data = extractJson(raw); } catch (e) { new Notice("Атлас вернул не JSON"); return; }
    const items = (data.items || []).slice(0, 20);
    if (!items.length) { new Notice("Замечаний нет"); return; }
    await this.ensureFolder(this.settings.reviewFolder);
    const path = this.settings.reviewFolder + "/" + f.basename + " — ревью " + stamp() + ".md";
    let md = "# Ревью: " + f.basename + "\n\n> Автоматическое ревью. Это не правка заметки.\n\n";
    for (const it of items) md += "- [ ] **" + (it.kind || "пункт") + "**: " + (it.issue || "") + "\n  > " + (it.quote || "").replace(/\n/g, " ") + "\n  → " + (it.suggestion || "") + "\n";
    md += "\nИсходная заметка: [[" + f.basename + "]]\n";
    await this.app.vault.create(path, md);
    await this.openPath(path);
    new Notice("Ревью готово: " + items.length + " пунктов");
  }

  async digest() {
    const root = this.settings.projectRoot;
    const files = this.app.vault.getFiles().filter(f => f.path.startsWith(root + "/") && f.extension === "md" && !f.path.includes("/AI/"));
    files.sort((a, b) => b.stat.mtime - a.stat.mtime);
    const recent = files.slice(0, 6);
    const chunks = [];
    for (const f of recent) { try { chunks.push("### " + f.path + "\n" + truncate(await this.app.vault.read(f), 4000)); } catch (e) {} }
    const prompt = "Собери краткий дайджест проекта по свежим заметкам. Верни markdown с разделами: Что изменилось, Решения, Открытые вопросы, Следующие шаги. 8–15 строк, только по тексту, без выдумок.\n\n" + chunks.join("\n\n");
    const md = await this.chat([{ role: "user", content: prompt }], { maxTokens: 2000, temperature: 0.3 });
    await this.ensureFolder(this.settings.digestFolder);
    const path = this.settings.digestFolder + "/" + today() + ".md";
    const text = "# Дайджест " + today() + "\n\n" + md + "\n\n---\nСобрано по: " + recent.map(f => "[[" + f.basename + "]]").join(", ") + "\n";
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.modify(this.app.vault.getAbstractFileByPath(path), text);
    else await this.app.vault.create(path, text);
    await this.openPath(path);
  }

  async openProjectHome() {
    const p = this.settings.projectRoot + "/00 Дом проекта.md";
    if (await this.app.vault.adapter.exists(p)) await this.openPath(p);
    else new Notice("Нет дома проекта: " + p);
  }

  async brainstorm() {
    const modal = new Modal(this.app);
    modal.contentEl.createEl("h2", { text: "Брейншторм на канвасе" });
    const input = modal.contentEl.createEl("textarea", { attr: { rows: "3", style: "width:100%" } });
    input.placeholder = "Тема или вопрос";
    input.focus();
    const btn = modal.contentEl.createEl("button", { text: "Сгенерировать", cls: "mod-cta" });
    btn.style.marginTop = "10px";
    btn.onclick = async () => { const topic = input.value.trim(); if (!topic) return; modal.close(); await this.brainstormTopic(topic); };
    modal.open();
  }

  async brainstormTopic(topic) {
    const notice = new Notice("Atlas собирает идеи…", 0);
    try {
      const prompt = "Проведи брейншторм по теме: " + topic + "\nВерни СТРОГО JSON: {\"cards\":[{\"text\":\"идея\"}]}. 8–12 карточек, каждая — короткая конкретная мысль.";
      const raw = await this.chat([{ role: "user", content: prompt }], { maxTokens: 2500, temperature: 0.9 });
      const data = extractJson(raw); const cards = (data.cards || []).slice(0, 16);
      if (!cards.length) throw new Error("нет карточек");
      const nodes = cards.map((c, i) => ({ id: "n" + i, type: "text", text: String(c.text || ""), x: (i % 3) * 340, y: Math.floor(i / 3) * 220, width: 300, height: 140 }));
      const path = this.settings.projectRoot + "/brainstorm-" + stamp() + ".canvas";
      await this.app.vault.create(path, JSON.stringify({ nodes, edges: [] }, null, 2));
      await this.openPath(path);
      notice.hide(); new Notice("Готово: " + cards.length + " идей");
    } catch (e) { notice.hide(); new Notice("Ошибка брейншторма: " + (e.message || e)); }
  }
}

module.exports = AtlasCoworkPlugin;
