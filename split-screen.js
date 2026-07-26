/* global Zotero, Services */

ZoteroSplitScreen = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	windows: new Map(),
	sessions: new Map(),
	maxSources: 12,
	maxPanes: 4,
	comparisonFields: [
		["question", "研究问题"],
		["theory", "理论 / 假设"],
		["method", "方法 / 模型"],
		["data", "数据 / 实验设置"],
		["metrics", "评价指标"],
		["results", "关键结果"],
		["innovation", "创新点"],
		["limits", "局限与适用范围"],
		["reproducibility", "可复现性"],
		["judgement", "我的判断"],
	],

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(message) {
		Zotero.debug("Zotero Split Screen: " + message);
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.addToWindow(win);
		}
	},

	addToWindow(win) {
		if (!win?.ZoteroPane || this.windows.has(win)) return;
		let record = { elements: [], listeners: [] };
		this.windows.set(win, record);
		this._addStylesheet(win, record);
		this._addToolsMenu(win, record);
		this._addItemContextMenu(win, record);
	},

	removeFromWindow(win) {
		for (let session of Array.from(this.sessions.values())) {
			if (session.win === win) this._destroySession(session);
		}
		let record = this.windows.get(win);
		if (!record) return;
		for (let { target, type, listener } of record.listeners) {
			target.removeEventListener(type, listener);
		}
		for (let element of record.elements) element.remove();
		this.windows.delete(win);
	},

	shutdown() {
		for (let session of Array.from(this.sessions.values())) {
			this._destroySession(session);
		}
		for (let win of Array.from(this.windows.keys())) this.removeFromWindow(win);
		this.initialized = false;
	},

	_createXUL(doc, name, attributes = {}) {
		let element = doc.createXULElement(name);
		for (let [key, value] of Object.entries(attributes)) {
			element.setAttribute(key, String(value));
		}
		return element;
	},

	_createHTML(doc, name, attributes = {}) {
		let element = doc.createElementNS("http://www.w3.org/1999/xhtml", name);
		for (let [key, value] of Object.entries(attributes)) {
			element.setAttribute(key, String(value));
		}
		return element;
	},

	_addStylesheet(win, record) {
		let link = win.document.createElement("link");
		link.id = "zotero-split-screen-stylesheet";
		link.rel = "stylesheet";
		link.type = "text/css";
		link.href = this.rootURI + "workspace.css";
		win.document.documentElement.appendChild(link);
		record.elements.push(link);
	},

	_addToolsMenu(win, record) {
		let doc = win.document;
		let toolsPopup = doc.getElementById("menu_ToolsPopup");
		if (!toolsPopup) return;

		let menu = this._createXUL(doc, "menu", {
			id: "zotero-split-screen-tools-menu",
			label: "论文对比"
		});
		let popup = this._createXUL(doc, "menupopup");
		menu.appendChild(popup);
		this._appendCommand(doc, popup, "打开或添加所选文献", () => this.openSelected(win));
		this._appendCommand(doc, popup, "使用已打开的 PDF 标签页", () => this.openAlreadyOpenPDFs(win));
		popup.appendChild(this._createXUL(doc, "menuseparator"));
		this._appendCommand(doc, popup, "双栏布局", () => this._withSession(win, session => this.setLayout(session, "columns")));
		this._appendCommand(doc, popup, "上下布局", () => this._withSession(win, session => this.setLayout(session, "rows")));
		this._appendCommand(doc, popup, "网格布局", () => this._withSession(win, session => this.setLayout(session, "grid")));
		popup.appendChild(this._createXUL(doc, "menuseparator"));
		let syncItem = this._appendCommand(doc, popup, "同步页码", () => {
			this._withSession(win, session => this.setSyncEnabled(session, !session.syncEnabled));
		}, { type: "checkbox", id: "zotero-split-screen-sync-main" });
		this._appendCommand(doc, popup, "同步到当前主窗格", () => this._withSession(win, session => this.syncNow(session, true)));

		let showing = () => {
			let session = this._getActiveSession(win);
			syncItem.setAttribute("checked", session?.syncEnabled ? "true" : "false");
			syncItem.disabled = !session;
		};
		popup.addEventListener("popupshowing", showing);
		record.listeners.push({ target: popup, type: "popupshowing", listener: showing });
		toolsPopup.appendChild(menu);
		record.elements.push(menu);
	},

	_addItemContextMenu(win, record) {
		let doc = win.document;
		let itemPopup = doc.getElementById("zotero-itemmenu");
		if (!itemPopup) return;

		let separator = this._createXUL(doc, "menuseparator", {
			id: "zotero-split-screen-context-separator"
		});
		let item = this._createXUL(doc, "menuitem", {
			id: "zotero-split-screen-context-open",
			label: "在论文对比工作台中打开"
		});
		item.addEventListener("command", () => this.openSelected(win));
		let showing = () => {
			let selected = win.ZoteroPane.getSelectedItems();
			let visible = selected.length >= 1;
			separator.hidden = !visible;
			item.hidden = !visible;
		};
		itemPopup.addEventListener("popupshowing", showing);
		record.listeners.push({ target: itemPopup, type: "popupshowing", listener: showing });
		itemPopup.append(separator, item);
		record.elements.push(separator, item);
	},

	_appendCommand(doc, popup, label, command, attributes = {}) {
		let item = this._createXUL(doc, "menuitem", { label, ...attributes });
		item.addEventListener("command", command);
		popup.appendChild(item);
		return item;
	},

	async openSelected(win) {
		return this.openItems(win.ZoteroPane.getSelectedItems(), win);
	},

	async openAlreadyOpenPDFs(win = Zotero.getMainWindow()) {
		let attachments = this._getAlreadyOpenPDFAttachments(win);
		if (!attachments.length) {
			this._alert(win, "论文对比", "当前没有可用于对比的已打开 PDF 标签页。");
			return;
		}

		let session = this._getActiveSession(win) || this._getWindowSession(win);
		if (!session) {
			session = this._createSession(win, attachments);
			this._buildWorkspace(session);
			this._renderSources(session);
			this._renderPanes(session);
			return;
		}

		// Merge newly opened tabs into the candidate library. Existing candidates
		// and the documents already assigned to A/B/C/D must never be replaced by
		// this refresh action.
		let previousCount = session.sources.length;
		this._addSources(session, attachments);
		let targetCount = session.layout === "grid"
			? Math.min(this.maxPanes, session.sources.length)
			: Math.min(2, session.sources.length);
		this._setPaneCount(session, targetCount);
		this._renderPanes(session);
		this._renderSources(session);
		this._setNoteStatus(session, session.sources.length > previousCount
			? `已添加 ${session.sources.length - previousCount} 篇打开的 PDF`
			: "已打开的 PDF 均在候选文献中");
		win.Zotero_Tabs.select(session.tabID);
	},

	async openItems(items, win = Zotero.getMainWindow()) {
		try {
			let attachments = this._resolvePDFAttachments(items);
			if (!attachments.length) {
				this._alert(win, "论文对比", "请选择带有 PDF 附件的文献，或直接选择 PDF 附件。");
				return;
			}

			let session = this._getActiveSession(win) || this._getWindowSession(win);
			if (session) {
				let added = this._addSources(session, attachments);
				if (!added) {
					this._alert(win, "论文对比", "所选 PDF 已经在当前对比工作台中。");
				}
				let pane = session.panes[session.activePaneIndex];
				if (pane) this._setPaneAttachment(session, pane, attachments[0]);
				win.Zotero_Tabs.select(session.tabID);
				return;
			}

			session = this._createSession(win, attachments);
			this._buildWorkspace(session);
			this._renderSources(session);
			this._renderPanes(session);
		}
		catch (error) {
			Zotero.logError(error);
			this._alert(win, "论文对比", "打开对比工作台失败。请在“帮助 → 调试输出日志”中查看详细信息。");
		}
	},

	_createSession(win, attachments) {
		let comparisonID = attachments.map(x => x.id).sort((a, b) => a - b).join("_");
		let uiState = this._readJSONPref("extensions.zotero-split-screen.ui-state", {});
		let workspaceKey = "extensions.zotero-split-screen.workspace." + comparisonID;
		let workspaceState = this._readJSONPref(workspaceKey, {});
		let tab = win.Zotero_Tabs.add({
			type: "zss-comparison",
			title: "论文对比",
			data: {},
			select: true,
			onClose: () => {
				let session = this.sessions.get(tab.id);
				if (session) this._destroySession(session, false);
			}
		});
		let session = {
			id: tab.id,
			tabID: tab.id,
			win,
			container: tab.container,
			sources: attachments.slice(0, this.maxSources),
			panes: [],
			activePaneIndex: 0,
			layout: ["columns", "rows", "grid"].includes(workspaceState.layout) ? workspaceState.layout : "columns",
			focusMode: false,
			syncEnabled: false,
			syncTimer: null,
			syncBusy: false,
			lastMasterPage: null,
			alignmentOffsets: null,
			noteSaveTimer: null,
			comparisonID,
			workspaceKey,
			savedSlotIDs: Array.isArray(workspaceState.slotIDs) ? workspaceState.slotIDs : [],
			savedPages: workspaceState.pages || {},
			noteKey: "extensions.zotero-split-screen.notes." + comparisonID,
			noteIDKey: "extensions.zotero-split-screen.note-id." + comparisonID,
			structuredKey: "extensions.zotero-split-screen.structured." + comparisonID,
			noteWritePromise: Promise.resolve(),
			sourcesCollapsed: Boolean(uiState.sourcesCollapsed),
			notesCollapsed: Boolean(uiState.notesCollapsed),
			sourcesWidth: this._clampNumber(uiState.sourcesWidth, 170, 320, 210),
			notesWidth: this._clampNumber(uiState.notesWidth, 320, 520, 400),
			noteView: uiState.noteView === "structured" ? "structured" : "native"
		};
		this.sessions.set(tab.id, session);
		return session;
	},

	_buildWorkspace(session) {
		let doc = session.win.document;
		session.container.setAttribute("flex", "1");
		let root = this._createXUL(doc, "vbox", { flex: 1, class: "zss-workspace" });
		session.root = root;

		let toolbar = this._createXUL(doc, "toolbar", { class: "zss-toolbar" });
		toolbar.appendChild(this._createXUL(doc, "label", { value: "论文对比工作台", class: "zss-title" }));
		this._appendToolbarButton(doc, toolbar, "读取标签页", "直接把当前已打开的 Zotero PDF 标签页载入候选文献", () => {
			this.openAlreadyOpenPDFs(session.win);
		});
		this._appendToolbarButton(doc, toolbar, "添加所选", "用主界面当前所选 PDF 替换高亮窗格", () => {
			this._appendCurrentSelection(session);
		});
		this._appendToolbarButton(doc, toolbar, "双栏", "左右并排阅读", () => this.setLayout(session, "columns"));
		this._appendToolbarButton(doc, toolbar, "上下", "上下并排阅读", () => this.setLayout(session, "rows"));
		this._appendToolbarButton(doc, toolbar, "网格", "四窗格网格阅读", () => this.setLayout(session, "grid"));
		this._appendToolbarButton(doc, toolbar, "交换", "交换前两个窗格中的文献", () => this._swapPrimaryPanes(session));
		let focusButton = this._appendToolbarButton(doc, toolbar, "聚焦", "只显示当前高亮窗格，便于精读和标注", () => {
			this._toggleFocusMode(session);
		}, { type: "checkbox" });
		session.focusButton = focusButton;
		let syncButton = this._appendToolbarButton(doc, toolbar, "同步页码", "以高亮窗格同步其他文献", () => {
			this.setSyncEnabled(session, !session.syncEnabled);
		}, { type: "checkbox", id: "zss-sync-button" });
		session.syncButton = syncButton;
		this._appendToolbarButton(doc, toolbar, "对齐当前页", "将各窗格当前页设为同一个语义起点，再进行相对同步", () => {
			this.alignCurrentPages(session);
		});
		let moreButton = this._createXUL(doc, "toolbarbutton", {
			label: "更多",
			type: "menu",
			class: "zss-toolbar-button"
		});
		let morePopup = this._createXUL(doc, "menupopup");
		this._appendCommand(doc, morePopup, "切换文献栏", () => this._toggleSidePanel(session, "sources"));
		this._appendCommand(doc, morePopup, "切换笔记栏", () => this._toggleSidePanel(session, "notes"));
		this._appendCommand(doc, morePopup, "所有窗格上一页", () => this._goAll(session, "prev"));
		this._appendCommand(doc, morePopup, "所有窗格下一页", () => this._goAll(session, "next"));
		moreButton.appendChild(morePopup);
		toolbar.appendChild(moreButton);
		root.appendChild(toolbar);

		let content = this._createXUL(doc, "hbox", { flex: 1, class: "zss-content" });
		let sources = this._createXUL(doc, "vbox", { class: "zss-sources" });
		sources.style.width = `${session.sourcesWidth}px`;
		let sourceHeader = this._createXUL(doc, "hbox", { align: "center", class: "zss-panel-heading" });
		let collapseSources = this._createXUL(doc, "toolbarbutton", {
			label: session.sourcesCollapsed ? "›" : "‹",
			tooltiptext: "收起或展开对比文献",
			class: "zss-panel-collapse"
		});
		collapseSources.addEventListener("command", () => this._toggleSidePanel(session, "sources"));
		sourceHeader.appendChild(collapseSources);
		sourceHeader.appendChild(this._createXUL(doc, "label", { flex: 1, value: "对比文献", class: "zss-panel-title" }));
		let refreshSources = this._createXUL(doc, "toolbarbutton", {
			label: "刷新",
			tooltiptext: "重新读取上方已打开的 PDF 标签页",
			class: "zss-panel-action"
		});
		refreshSources.addEventListener("command", () => this.openAlreadyOpenPDFs(session.win));
		sourceHeader.appendChild(refreshSources);
		sources.appendChild(sourceHeader);
		let sourcesBody = this._createXUL(doc, "vbox", { flex: 1, class: "zss-panel-body" });
		sourcesBody.appendChild(this._createXUL(doc, "description", {
			class: "zss-panel-hint",
			value: "点击标题替换红框窗格，或直接放入 A / B"
		}));
		let sourceSearch = this._createHTML(doc, "input", {
			type: "search",
			placeholder: "筛选候选文献…",
			class: "zss-source-search"
		});
		sourceSearch.addEventListener("input", () => {
			session.sourceFilter = sourceSearch.value.trim().toLocaleLowerCase();
			this._renderSources(session);
		});
		sourcesBody.appendChild(sourceSearch);
		let sourceList = this._createXUL(doc, "vbox", { flex: 1, class: "zss-source-list" });
		sourcesBody.appendChild(sourceList);
		sources.appendChild(sourcesBody);
		session.sourcesPanel = sources;
		session.sourcesBody = sourcesBody;
		session.sourcesCollapseButton = collapseSources;
		session.sourceList = sourceList;
		this._applyPanelState(session, "sources");
		let sourceSplitter = this._createXUL(doc, "splitter", {
			class: "zss-panel-splitter zss-source-splitter",
			resizebefore: "closest",
			resizeafter: "closest"
		});
		sourceSplitter.addEventListener("mouseup", () => this._rememberPanelWidths(session));
		session.sourceSplitter = sourceSplitter;
		this._applyPanelState(session, "sources");

		let grid = this._createXUL(doc, "vbox", { flex: 1, class: "zss-reader-grid" });
		session.grid = grid;

		let notes = this._createXUL(doc, "vbox", { class: "zss-notes" });
		notes.style.width = `${session.notesWidth}px`;
		session.notesPanel = notes;
		let noteHeader = this._createXUL(doc, "hbox", { align: "center", class: "zss-panel-heading" });
		let collapseNotes = this._createXUL(doc, "toolbarbutton", {
			label: session.notesCollapsed ? "‹" : "收回 ›",
			tooltiptext: "收起或展开对比笔记",
			class: "zss-panel-collapse zss-notes-collapse"
		});
		collapseNotes.addEventListener("command", () => this._toggleSidePanel(session, "notes"));
		noteHeader.appendChild(collapseNotes);
		noteHeader.appendChild(this._createXUL(doc, "label", { flex: 1, value: "对比笔记", class: "zss-panel-title" }));
		notes.appendChild(noteHeader);
		let notesBody = this._createXUL(doc, "vbox", { flex: 1, class: "zss-panel-body" });
		let noteTabs = this._createXUL(doc, "hbox", { class: "zss-note-tabs" });
		let nativeTab = this._createXUL(doc, "toolbarbutton", { label: "Zotero 笔记", class: "zss-note-tab" });
		let structuredTab = this._createXUL(doc, "toolbarbutton", { label: "结构化对比", class: "zss-note-tab" });
		nativeTab.addEventListener("command", () => this._setNoteView(session, "native"));
		structuredTab.addEventListener("command", () => this._setNoteView(session, "structured"));
		noteTabs.append(nativeTab, structuredTab);
		notesBody.appendChild(noteTabs);
		let noteDeck = this._createXUL(doc, "deck", { flex: 1, class: "zss-note-deck" });
		let nativeHost = this._createXUL(doc, "vbox", { flex: 1, class: "zss-native-note-host" });
		nativeHost.appendChild(this._createXUL(doc, "label", { value: "正在加载 Zotero 笔记…", class: "zss-note-loading" }));
		let structuredHost = this._createXUL(doc, "vbox", { flex: 1, class: "zss-structured-host" });
		noteDeck.append(nativeHost, structuredHost);
		notesBody.appendChild(noteDeck);
		let noteActions = this._createXUL(doc, "hbox", { class: "zss-note-actions", align: "center" });
		let noteStatus = this._createXUL(doc, "label", { flex: 1, value: "", class: "zss-note-status" });
		let openNoteButton = this._createXUL(doc, "toolbarbutton", { label: "独立打开", class: "zss-note-save" });
		openNoteButton.addEventListener("command", () => this._openBoundNote(session));
		noteActions.append(noteStatus, openNoteButton);
		notesBody.appendChild(noteActions);
		notes.appendChild(notesBody);
		session.notesBody = notesBody;
		session.notesCollapseButton = collapseNotes;
		session.noteTabs = { native: nativeTab, structured: structuredTab };
		session.noteDeck = noteDeck;
		session.nativeNoteHost = nativeHost;
		session.structuredHost = structuredHost;
		session.noteStatus = noteStatus;
		this._buildStructuredPanel(session);
		this._applyPanelState(session, "notes");
		this._setNoteView(session, session.noteView);
		let noteSplitter = this._createXUL(doc, "splitter", {
			class: "zss-panel-splitter zss-note-splitter",
			resizebefore: "closest",
			resizeafter: "closest"
		});
		noteSplitter.addEventListener("mouseup", () => this._rememberPanelWidths(session));
		session.noteSplitter = noteSplitter;
		this._applyPanelState(session, "notes");

		content.append(sources, sourceSplitter, grid, noteSplitter, notes);
		root.appendChild(content);
		session.container.appendChild(root);
		this._initializeNativeNote(session);

		let orderedSources = [
			...session.savedSlotIDs.map(id => session.sources.find(item => item.id === id)).filter(Boolean),
			...session.sources.filter(item => !session.savedSlotIDs.includes(item.id))
		];
		let visibleCount = session.layout === "grid"
			? Math.min(session.sources.length, this.maxPanes)
			: Math.min(session.sources.length, 2);
		for (let index = 0; index < visibleCount; index++) {
			session.panes.push(this._createPane(session, orderedSources[index]));
		}
	},

	_appendToolbarButton(doc, toolbar, label, tooltip, command, attributes = {}) {
		let button = this._createXUL(doc, "toolbarbutton", {
			label,
			tooltiptext: tooltip,
			class: "zss-toolbar-button",
			...attributes
		});
		button.addEventListener("command", command);
		toolbar.appendChild(button);
		return button;
	},

	_createPane(session, attachment) {
		let doc = session.win.document;
		let root = this._createXUL(doc, "vbox", { flex: 1, class: "zss-reader-pane" });
		let header = this._createXUL(doc, "hbox", { class: "zss-pane-header", align: "center" });
		let marker = this._createXUL(doc, "label", { value: "", class: "zss-pane-marker" });
		let title = this._createXUL(doc, "label", { flex: 1, crop: "end", class: "zss-pane-title" });
		let previousButton = this._createXUL(doc, "toolbarbutton", {
			label: "\u2039",
			tooltiptext: "\u4e0a\u4e00\u9875",
			class: "zss-pane-page-button"
		});
		let nextButton = this._createXUL(doc, "toolbarbutton", {
			label: "\u203a",
			tooltiptext: "\u4e0b\u4e00\u9875",
			class: "zss-pane-page-button"
		});
		let switchButton = this._createXUL(doc, "toolbarbutton", {
			label: "切换",
			type: "menu",
			tooltiptext: "选择此窗格要显示的文献",
			class: "zss-pane-switch"
		});
		let switchPopup = this._createXUL(doc, "menupopup");
		switchButton.appendChild(switchPopup);
		header.append(marker, title, previousButton, nextButton, switchButton);
		let host = this._createXUL(doc, "vbox", { flex: 1, class: "zss-preview-host" });
		let popupset = this._createXUL(doc, "popupset");
		root.append(header, host, popupset);

		let pane = {
			root, header, marker, title, previousButton, nextButton, switchButton, switchPopup, host, popupset,
			attachment: null, preview: null, loadToken: 0, disposed: false
		};
		let setActive = () => this._setActivePane(session, session.panes.indexOf(pane));
		root.addEventListener("mousedown", setActive, true);
		switchButton.addEventListener("mousedown", setActive);
		switchPopup.addEventListener("popupshowing", () => this._renderPaneSwitchMenu(session, pane));
		previousButton.addEventListener("command", event => {
			event.stopPropagation();
			setActive();
			this._goActive(session, "prev");
		});
		nextButton.addEventListener("command", event => {
			event.stopPropagation();
			setActive();
			this._goActive(session, "next");
		});
		this._setPaneAttachment(session, pane, attachment);
		return pane;
	},

	async _setPaneAttachment(session, pane, attachment) {
		if (!attachment || pane.disposed) return;
		if (pane.attachment?.id !== attachment.id) session.alignmentOffsets = null;
		let token = ++pane.loadToken;
		if (pane.loading) {
			pane.pendingAttachment = attachment;
			return;
		}
		pane.loading = true;
		try {
			pane.preview?.uninit();
			pane.preview = null;
			pane.host.replaceChildren();
			pane.attachment = attachment;
			pane.title.setAttribute("value", this._getAttachmentTitle(attachment));
			let browser = this._createXUL(session.win.document, "browser", {
				tooltip: "iframeTooltip",
				type: "content",
				primary: true,
				flex: 1,
				transparent: "transparent",
				src: "resource://zotero/reader/reader.html",
				class: "zss-preview-browser"
			});
			let frameReady = this._waitForPreviewFrame(session.win, pane.host, browser);
			pane.host.appendChild(browser);
			await frameReady;
			let preview = await Zotero.Reader.openPreview(attachment.id, browser);
			// openPreview() gives us a Reader instance bound to this browser, but its
			// own _open() forces preview mode. Preview mode disables the PDF text
			// layer and does not render Zotero's native reader UI. Call the base
			// ReaderInstance implementation with preview:false so annotations,
			// sidebars, keyboard commands, and reader-plugin hooks remain available.
			let readerPreviewPrototype = Object.getPrototypeOf(preview);
			let readerInstancePrototype = Object.getPrototypeOf(readerPreviewPrototype);
			preview._isReadOnly = () => readerInstancePrototype._isReadOnly.call(preview);
			preview._window = session.win;
			preview._popupset = pane.popupset;
			preview._sidebarWidth = 240;
			preview._sidebarOpen = false;
			preview._showContextPaneToggle = true;
			let success = await readerInstancePrototype._open.call(preview, { preview: false });
			if (!success) throw new Error("ReaderPreview failed to initialize");
			await preview._initPromise;
			if (pane.disposed || token !== pane.loadToken) {
				preview.uninit();
				return;
			}
			this._enablePDFInteraction(preview);
			pane.preview = preview;
			let savedPage = Number(session.savedPages?.[attachment.id]);
			if (Number.isInteger(savedPage) && savedPage > 0) {
				await preview.navigate({ pageIndex: savedPage });
			}
			this._renderSources(session);
			this._persistWorkspaceState(session);
		}
		catch (error) {
			if (pane.disposed || token !== pane.loadToken) return;
			Zotero.logError(error);
			pane.host.replaceChildren(this._createXUL(session.win.document, "label", {
				value: "无法载入此 PDF",
				class: "zss-load-error"
			}));
		}
		finally {
			pane.loading = false;
			if (!pane.disposed && pane.pendingAttachment) {
				let pending = pane.pendingAttachment;
				pane.pendingAttachment = null;
				this._setPaneAttachment(session, pane, pending);
			}
		}
	},

	_enablePDFInteraction(preview) {
		let readerWindow = preview?._internalReader?._primaryView?._iframeWindow;
		let viewer = readerWindow?.PDFViewerApplication?.pdfViewer;
		if (!readerWindow || !viewer) return;
		try {
			// ReaderPreview forces page-scroll and hides the viewer scrollbar. That is
			// useful for compact previews but prevents normal reading with a wheel.
			readerWindow.removeEventListener("resize", preview.updatePDFAttr);
			viewer.scrollMode = 0;
			viewer.currentScaleValue = "page-width";
			let style = readerWindow.document.createElement("style");
			style.textContent = `
				#viewerContainer { overflow: auto !important; }
				.textLayer { pointer-events: auto !important; user-select: text !important; }
			`;
			readerWindow.document.head.appendChild(style);
		}
		catch (error) {
			Zotero.logError(error);
		}
	},

	_waitForPreviewFrame(win, host, browser) {
		return new Promise((resolve, reject) => {
			let timeout = win.setTimeout(() => {
				host.removeEventListener("DOMContentLoaded", onLoad);
				reject(new Error("Timed out while loading the embedded Zotero Reader"));
			}, 15000);
			let onLoad = event => {
				if (event.target === browser.contentWindow?.document) {
					host.removeEventListener("DOMContentLoaded", onLoad);
					win.clearTimeout(timeout);
					resolve();
				}
			};
			host.addEventListener("DOMContentLoaded", onLoad);
		});
	},

	_renderPanes(session) {
		// ReaderPreview owns a live browser. Removing an initialized browser from
		// the document can leave Zotero's preview blank, so physical rows remain
		// mounted and layout changes only alter orientation and visibility.
		if (!session.paneRows) {
			let outer = this._createXUL(session.win.document, "vbox", { flex: 1, class: "zss-grid-rows" });
			session.paneRows = [];
			for (let index = 0; index < 2; index++) {
				let row = this._createXUL(session.win.document, "box", {
					flex: 1,
					orient: "horizontal",
					class: "zss-grid-row"
				});
				session.paneRows.push(row);
				outer.appendChild(row);
			}
			session.grid.replaceChildren(outer);
		}

		for (let [index, pane] of session.panes.entries()) {
			let row = session.paneRows[Math.floor(index / 2)];
			// Existing readers stay where they are. Only a new pane is attached.
			if (row && pane.root.parentNode !== row) row.appendChild(pane.root);
		}

		let firstRow = session.paneRows[0];
		let secondRow = session.paneRows[1];
		let count = session.panes.length;
		firstRow.setAttribute("orient", session.layout === "rows" ? "vertical" : "horizontal");
		secondRow.setAttribute("orient", "horizontal");
		for (let [index, pane] of session.panes.entries()) {
			pane.root.hidden = Boolean(session.focusMode && index !== session.activePaneIndex);
		}
		if (session.focusMode) {
			firstRow.hidden = session.activePaneIndex >= 2 || count === 0;
			secondRow.hidden = session.activePaneIndex < 2 || count === 0;
		}
		else {
			firstRow.hidden = count === 0;
			secondRow.hidden = session.layout !== "grid" || count < 3;
		}
		this._setActivePane(session, Math.min(session.activePaneIndex, Math.max(0, count - 1)));
	},

	_renderSources(session) {
		let list = session.sourceList;
		if (!list) return;
		list.replaceChildren();
		for (let attachment of session.sources) {
			let fullTitle = this._getAttachmentTitle(attachment);
			if (session.sourceFilter && !fullTitle.toLocaleLowerCase().includes(session.sourceFilter)) continue;
			let paneIndex = session.panes.findIndex(pane => pane.attachment?.id === attachment.id);
			let card = this._createHTML(session.win.document, "div", { class: "zss-source-card" });
			card.toggleAttribute("data-zss-visible", paneIndex >= 0);
			let main = this._createHTML(session.win.document, "button", {
				type: "button",
				class: "zss-source-main",
				title: fullTitle
			});
			let title = this._createHTML(session.win.document, "span", { class: "zss-source-title" });
			title.textContent = fullTitle;
			let badge = this._createHTML(session.win.document, "span", { class: "zss-source-badge" });
			badge.textContent = paneIndex >= 0 ? String.fromCharCode(65 + paneIndex) : "";
			if (paneIndex === 0) badge.classList.add("zss-slot-a");
			if (paneIndex === 1) badge.classList.add("zss-slot-b");
			main.append(title, badge);
			main.addEventListener("click", () => {
				let pane = session.panes[session.activePaneIndex];
				if (pane) this._setPaneAttachment(session, pane, attachment);
			});
			let actions = this._createHTML(session.win.document, "div", { class: "zss-source-actions" });
			for (let index = 0; index < 2; index++) {
				let assign = this._createHTML(session.win.document, "button", {
					type: "button",
					class: "zss-source-slot",
					title: `放入窗格 ${String.fromCharCode(65 + index)}`
				});
				assign.textContent = String.fromCharCode(65 + index);
				assign.addEventListener("click", event => {
					event.stopPropagation();
					this._assignSourceToPane(session, attachment, index);
				});
				actions.appendChild(assign);
			}
			card.append(main, actions);
			list.appendChild(card);
		}
	},

	_assignSourceToPane(session, attachment, paneIndex) {
		if (!session || !attachment || paneIndex < 0 || paneIndex > 3) return;
		if (!session.panes[paneIndex]) {
			this._setPaneCount(session, Math.min(paneIndex + 1, session.sources.length, this.maxPanes));
			this._renderPanes(session);
		}
		let pane = session.panes[paneIndex];
		if (!pane) return;
		this._setActivePane(session, paneIndex);
		this._setPaneAttachment(session, pane, attachment);
	},

	_renderPaneSwitchMenu(session, pane) {
		let popup = pane.switchPopup;
		if (!popup) return;
		popup.replaceChildren();
		for (let attachment of session.sources) {
			let item = this._createXUL(session.win.document, "menuitem", {
				label: this._getAttachmentTitle(attachment),
				type: "radio",
				checked: pane.attachment?.id === attachment.id ? "true" : "false"
			});
			item.addEventListener("command", () => {
				this._setActivePane(session, session.panes.indexOf(pane));
				this._setPaneAttachment(session, pane, attachment);
			});
			popup.appendChild(item);
		}
	},

	_setActivePane(session, index) {
		if (!Number.isInteger(index) || index < 0 || !session.panes[index]) return;
		session.activePaneIndex = index;
		session.panes.forEach((pane, paneIndex) => {
			pane.root.toggleAttribute("data-zss-active", paneIndex === index);
			let slot = String.fromCharCode(65 + paneIndex);
			pane.root.setAttribute("data-zss-slot", slot);
			pane.marker.setAttribute("value", paneIndex === index ? `${slot} · 主` : slot);
		});
	},

	setLayout(session, layout) {
		if (!session || !["columns", "rows", "grid"].includes(layout)) return;
		session.layout = layout;
		let targetCount = layout === "grid"
			? Math.min(this.maxPanes, session.sources.length)
			: Math.min(2, session.sources.length);
		this._setPaneCount(session, targetCount);
		this._renderPanes(session);
		this._persistWorkspaceState(session);
	},

	_swapPrimaryPanes(session) {
		if (!session?.panes[0]?.attachment || !session?.panes[1]?.attachment) return;
		let first = session.panes[0].attachment;
		let second = session.panes[1].attachment;
		this._setPaneAttachment(session, session.panes[0], second);
		this._setPaneAttachment(session, session.panes[1], first);
	},

	_toggleFocusMode(session) {
		if (!session) return;
		session.focusMode = !session.focusMode;
		session.focusButton?.setAttribute("checked", session.focusMode ? "true" : "false");
		this._renderPanes(session);
	},

	_toggleSidePanel(session, panelName) {
		if (!session || !["sources", "notes"].includes(panelName)) return;
		let key = panelName === "sources" ? "sourcesCollapsed" : "notesCollapsed";
		session[key] = !session[key];
		this._applyPanelState(session, panelName);
		this._rememberPanelWidths(session);
	},

	_applyPanelState(session, panelName) {
		let isSources = panelName === "sources";
		let panel = isSources ? session.sourcesPanel : session.notesPanel;
		let splitter = isSources ? session.sourceSplitter : session.noteSplitter;
		let button = isSources ? session.sourcesCollapseButton : session.notesCollapseButton;
		let collapsed = isSources ? session.sourcesCollapsed : session.notesCollapsed;
		let width = isSources ? session.sourcesWidth : session.notesWidth;
		if (!panel) return;
		panel.toggleAttribute("data-zss-collapsed", collapsed);
		panel.style.width = `${collapsed ? 34 : width}px`;
		panel.style.minWidth = `${collapsed ? 34 : Math.min(width, isSources ? 170 : 320)}px`;
		if (button) button.setAttribute("label", isSources
			? (collapsed ? "›" : "‹")
			: (collapsed ? "‹" : "收回 ›"));
		if (splitter) splitter.hidden = collapsed;
	},

	_rememberPanelWidths(session) {
		if (!session) return;
		if (!session.sourcesCollapsed && session.sourcesPanel) {
			let width = session.sourcesPanel.getBoundingClientRect().width;
			if (width >= 100) session.sourcesWidth = this._clampNumber(width, 170, 320, session.sourcesWidth);
		}
		if (!session.notesCollapsed && session.notesPanel) {
			let width = session.notesPanel.getBoundingClientRect().width;
			if (width >= 100) session.notesWidth = this._clampNumber(width, 320, 520, session.notesWidth);
		}
		this._writeJSONPref("extensions.zotero-split-screen.ui-state", {
			sourcesCollapsed: session.sourcesCollapsed,
			notesCollapsed: session.notesCollapsed,
			sourcesWidth: Math.round(session.sourcesWidth),
			notesWidth: Math.round(session.notesWidth),
			noteView: session.noteView
		});
	},

	_persistWorkspaceState(session) {
		if (!session?.workspaceKey) return;
		let pages = { ...(session.savedPages || {}) };
		for (let pane of session.panes) {
			let page = this._getPreviewPage(pane.preview);
			if (pane.attachment?.id && Number.isInteger(page)) pages[pane.attachment.id] = page;
		}
		session.savedPages = pages;
		this._writeJSONPref(session.workspaceKey, {
			layout: session.layout,
			slotIDs: session.panes.map(pane => pane.attachment?.id).filter(Boolean),
			pages
		});
	},

	_setPaneCount(session, targetCount) {
		while (session.panes.length > targetCount) {
			let pane = session.panes.pop();
			pane.disposed = true;
			pane.pendingAttachment = null;
			pane.loadToken++;
			try { pane.preview?.uninit(); }
			catch (error) { Zotero.logError(error); }
			pane.root.remove();
		}
		let usedIDs = new Set(session.panes.map(pane => pane.attachment?.id));
		while (session.panes.length < targetCount) {
			let source = session.sources.find(item => !usedIDs.has(item.id)) || session.sources[0];
			if (!source) break;
			usedIDs.add(source.id);
			session.panes.push(this._createPane(session, source));
		}
		session.activePaneIndex = Math.min(session.activePaneIndex, Math.max(0, session.panes.length - 1));
	},

	async _appendCurrentSelection(session) {
		let attachments = this._resolvePDFAttachments(session.win.ZoteroPane.getSelectedItems());
		if (!attachments.length) {
			this._alert(session.win, "论文对比", "请先在主文献列表中选择带 PDF 的文献。");
			return;
		}
		let added = this._addSources(session, attachments);
		if (!added) {
			this._alert(session.win, "论文对比", "所选 PDF 已经在工作台文献库中。");
		}
		let pane = session.panes[session.activePaneIndex];
		if (pane) this._setPaneAttachment(session, pane, attachments[0]);
	},

	_addSources(session, attachments) {
		let ids = new Set(session.sources.map(x => x.id));
		let additions = attachments.filter(item => !ids.has(item.id));
		let capacity = this.maxSources - session.sources.length;
		if (capacity <= 0 || !additions.length) return false;
		session.sources.push(...additions.slice(0, capacity));
		return true;
	},

	setSyncEnabled(session, enabled) {
		if (!session) return;
		if (session.syncTimer) {
			session.win.clearInterval(session.syncTimer);
			session.syncTimer = null;
		}
		session.syncEnabled = Boolean(enabled);
		session.lastMasterPage = null;
		session.syncButton?.setAttribute("checked", session.syncEnabled ? "true" : "false");
		if (session.syncEnabled && session.panes.length > 1) {
			session.syncTimer = session.win.setInterval(() => this.syncNow(session, false), 650);
			this.syncNow(session, true);
		}
	},

	alignCurrentPages(session) {
		if (!session?.panes.length) return;
		let master = session.panes[session.activePaneIndex];
		let masterPage = this._getPreviewPage(master?.preview);
		if (!Number.isInteger(masterPage)) return;
		let offsets = new Map();
		for (let pane of session.panes) {
			let page = this._getPreviewPage(pane.preview);
			if (Number.isInteger(page)) offsets.set(pane, page - masterPage);
		}
		session.alignmentOffsets = offsets;
		session.lastMasterPage = null;
		this._setNoteStatus(session, "已将各窗格当前页设为对齐起点");
	},

	async syncNow(session, force = false) {
		if (!session || session.syncBusy || (!force && !session.syncEnabled)) return;
		let master = session.panes[session.activePaneIndex];
		let pageIndex = this._getPreviewPage(master?.preview);
		if (!Number.isInteger(pageIndex)) return;
		if (!force && pageIndex === session.lastMasterPage) return;
		session.lastMasterPage = pageIndex;
		session.syncBusy = true;
		try {
			for (let pane of session.panes) {
				if (pane === master || !pane.preview) continue;
				let offset = session.alignmentOffsets?.get(pane) || 0;
				await pane.preview.navigate({ pageIndex: Math.max(0, pageIndex + offset) });
			}
		}
		catch (error) {
			Zotero.logError(error);
		}
		finally {
			session.syncBusy = false;
		}
	},

	_getPreviewPage(preview) {
		let pageNumber = preview?._internalReader?._primaryView?._iframeWindow
			?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
		return Number.isInteger(pageNumber) ? pageNumber - 1 : null;
	},

	_goActive(session, direction) {
		if (!session) return;
		let panes = session.syncEnabled
			? session.panes
			: [session.panes[session.activePaneIndex]];
		for (let pane of panes) {
			try {
				// ReaderPreview.goto() works before canGoto() has computed its state.
				pane?.preview?.goto(direction);
			}
			catch (error) {
				Zotero.logError(error);
			}
		}
	},

	_goAll(session, direction) {
		if (!session) return;
		for (let pane of session.panes) {
			try { pane.preview?.goto(direction); }
			catch (error) { Zotero.logError(error); }
		}
	},

	async _initializeNativeNote(session) {
		try {
			let storedID = Number(Zotero.Prefs.get(session.noteIDKey, true));
			let note = Number.isInteger(storedID) && Zotero.Items.get(storedID);
			let existingHTML = note?.isNote?.() ? note.getNote() : "";
			let needsEditableCopy = !note?.isNote?.()
				|| note.deleted
				|| note.isEditable?.() === false;
			if (needsEditableCopy) {
				let source = session.sources[0];
				let sourceEditable = source?.isEditable?.() !== false;
				note = new Zotero.Item("note");
				note.libraryID = sourceEditable
					? source?.libraryID
					: Zotero.Libraries.userLibraryID;
				note.parentID = sourceEditable ? (source?.parentID || null) : null;
				let legacyText = Zotero.Prefs.get(session.noteKey, true) || "";
				let legacyHTML = legacyText
					? `<p>${this._escapeHTML(legacyText).replace(/\r?\n/g, "<br>")}</p>`
					: "<p></p>";
				note.setNote(existingHTML || `<h1>论文对比笔记</h1>${legacyHTML}`);
				await note.saveTx();
				Zotero.Prefs.set(session.noteIDKey, note.id, true);
			}
			session.noteItem = note;
			session.noteItemID = note.id;
			let editor = session.win.document.createXULElement("note-editor");
			editor.classList.add("zss-native-note-editor");
			editor.setAttribute("flex", "1");
			editor.style.flex = "1";
			editor.style.display = "flex";
			session.nativeNoteHost.replaceChildren(editor);
			// Set edit mode before assigning the item. NoteEditor reads this value
			// when it creates EditorInstance; changing it afterwards is too late.
			editor.mode = "edit";
			editor.item = note;
			session.noteEditor = editor;
			editor.onInit(() => {
				this._makeNativeNoteResponsive(editor);
				this._setNoteStatus(session, "Zotero 笔记可编辑，内容自动保存");
			});
		}
		catch (error) {
			Zotero.logError(error);
			session.nativeNoteHost.replaceChildren(this._createXUL(session.win.document, "label", {
				value: "无法加载 Zotero 原生笔记",
				class: "zss-load-error"
			}));
			this._setNoteStatus(session, "笔记加载失败");
		}
	},

	_makeNativeNoteResponsive(editor) {
		if (!editor?.isConnected) return false;
		let iframe = editor._iframe
			|| editor._editorInstance?._iframe
			|| editor.querySelector?.("iframe, browser");
		let iframeDocument = iframe?.contentDocument
			|| editor._editorInstance?._iframeWindow?.document;
		if (!iframeDocument?.head) {
			let attempts = Number(editor._zssResponsiveAttempts || 0);
			if (attempts < 10) {
				editor._zssResponsiveAttempts = attempts + 1;
				editor.ownerDocument?.defaultView?.setTimeout(
					() => this._makeNativeNoteResponsive(editor),
					100
				);
			}
			return false;
		}
		if (iframeDocument.getElementById("zss-responsive-note-style")) return true;

		let style = iframeDocument.createElement("style");
		style.id = "zss-responsive-note-style";
		style.textContent = `
			html,
			body,
			#editor-container,
			.editor,
			.editor-core,
			.primary-editor {
				min-width: 0 !important;
				max-width: 100% !important;
				box-sizing: border-box !important;
			}

			#editor-container,
			.editor,
			.editor-core {
				width: 100% !important;
			}

			.editor-core {
				--editor-padding-inline: 14px !important;
			}

			.primary-editor,
			.primary-editor * {
				max-width: 100% !important;
			}

			.primary-editor p,
			.primary-editor blockquote,
			.primary-editor li {
				overflow-wrap: anywhere !important;
				word-break: break-word !important;
			}
		`;
		iframeDocument.head.appendChild(style);
		return true;
	},

	_openBoundNote(session) {
		if (session?.noteItemID) {
			session.win.ZoteroPane.openNote(session.noteItemID, { openInWindow: true });
		}
	},

	_setNoteView(session, view) {
		if (!session?.noteDeck || !["native", "structured"].includes(view)) return;
		session.noteView = view;
		session.noteDeck.selectedIndex = view === "native" ? 0 : 1;
		session.noteTabs.native.toggleAttribute("data-zss-selected", view === "native");
		session.noteTabs.structured.toggleAttribute("data-zss-selected", view === "structured");
		if (session.root?.isConnected) this._rememberPanelWidths(session);
	},

	_buildStructuredPanel(session) {
		let doc = session.win.document;
		let data = this._readJSONPref(session.structuredKey, {});
		session.structuredData = data;
		session.structuredEditors = new Map();
		let intro = this._createXUL(doc, "description", {
			class: "zss-panel-hint",
			value: "分别记录 A / B 文献，完成后可生成表格写入同一个 Zotero 笔记。"
		});
		let scroller = this._createHTML(doc, "div", { class: "zss-structured-scroll" });
		for (let [key, label] of this.comparisonFields) {
			let card = this._createHTML(doc, "section", { class: "zss-compare-field" });
			let heading = this._createHTML(doc, "h3", { class: "zss-compare-heading" });
			heading.textContent = label;
			card.appendChild(heading);
			for (let slot of ["A", "B"]) {
				let row = this._createHTML(doc, "label", { class: "zss-compare-row" });
				let badge = this._createHTML(doc, "span", { class: `zss-compare-slot zss-slot-${slot.toLowerCase()}` });
				badge.textContent = slot;
				let input = this._createHTML(doc, "textarea", {
					class: "zss-compare-input",
					rows: "2",
					placeholder: `${slot} 文献的${label}`
				});
				input.value = data[key]?.[slot] || "";
				input.addEventListener("input", () => {
					data[key] ||= {};
					data[key][slot] = input.value;
					this._scheduleStructuredSave(session);
				});
				input.addEventListener("dragover", event => event.preventDefault());
				input.addEventListener("drop", event => {
					let dropped = this._extractDroppedComparisonText(event, slot);
					if (!dropped) return;
					event.preventDefault();
					let prefix = input.value && !input.value.endsWith("\n") ? "\n" : "";
					input.setRangeText(prefix + dropped, input.selectionStart, input.selectionEnd, "end");
					data[key] ||= {};
					data[key][slot] = input.value;
					this._scheduleStructuredSave(session);
				});
				for (let eventName of ["keydown", "keypress", "keyup"]) {
					input.addEventListener(eventName, event => event.stopPropagation());
				}
				row.append(badge, input);
				card.appendChild(row);
				session.structuredEditors.set(`${key}.${slot}`, input);
			}
			scroller.appendChild(card);
		}
		let syncButton = this._createXUL(doc, "toolbarbutton", {
			label: "生成对比表并写入 Zotero 笔记",
			class: "zss-structured-sync"
		});
		syncButton.addEventListener("command", () => this._syncStructuredToNote(session));
		session.structuredHost.append(intro, scroller, syncButton);
	},

	_scheduleStructuredSave(session) {
		if (session.noteSaveTimer) session.win.clearTimeout(session.noteSaveTimer);
		this._setNoteStatus(session, "结构化对比正在保存…");
		session.noteSaveTimer = session.win.setTimeout(() => {
			this._writeJSONPref(session.structuredKey, session.structuredData);
			session.noteSaveTimer = null;
			this._setNoteStatus(session, "结构化对比已保存");
		}, 350);
	},

	async _syncStructuredToNote(session) {
		if (!session?.noteItem) return;
		this._setNoteStatus(session, "正在生成对比表…");
		try {
			session.noteEditor?.saveSync?.();
			this._writeJSONPref(session.structuredKey, session.structuredData);
			let panes = session.panes.slice(0, 2);
			let sourceLine = panes.map((pane, index) =>
				`<p><strong>${String.fromCharCode(65 + index)}：</strong>${this._escapeHTML(this._getAttachmentTitle(pane.attachment))}</p>`
			).join("");
			let rows = this.comparisonFields.map(([key, label]) => {
				let values = session.structuredData[key] || {};
				return `<tr><th>${this._escapeHTML(label)}</th><td>${this._formatNoteCell(values.A)}</td><td>${this._formatNoteCell(values.B)}</td></tr>`;
			}).join("");
			let generated = `<h2>结构化论文对比（由插件更新）</h2>${sourceLine}<table><tbody><tr><th>比较项</th><th>文献 A</th><th>文献 B</th></tr>${rows}</tbody></table><p>结构化对比表结束</p>`;
			let html = session.noteItem.getNote() || "<h1>论文对比笔记</h1>";
			let blockPattern = /<h2[^>]*>结构化论文对比（由插件更新）<\/h2>[\s\S]*?<p[^>]*>结构化对比表结束<\/p>/;
			html = blockPattern.test(html) ? html.replace(blockPattern, generated) : html + generated;
			session.noteItem.setNote(html);
			await session.noteItem.saveTx();
			this._setNoteStatus(session, "对比表已写入 Zotero 笔记");
			this._setNoteView(session, "native");
		}
		catch (error) {
			Zotero.logError(error);
			this._setNoteStatus(session, "写入失败，结构化草稿已保留");
		}
	},

	_extractDroppedComparisonText(event, slot) {
		try {
			let raw = event.dataTransfer?.getData("zotero/annotation");
			if (raw) {
				let annotations = JSON.parse(raw);
				if (!Array.isArray(annotations)) annotations = [annotations];
				return annotations.map(annotation => {
					let text = annotation.text || annotation.comment || "批注";
					let page = annotation.pageLabel ? ` p.${annotation.pageLabel}` : "";
					return `[${slot}${page}] ${text}`;
				}).join("\n");
			}
			let plain = event.dataTransfer?.getData("text/plain");
			return plain ? `[${slot}] ${plain}` : "";
		}
		catch (error) {
			Zotero.logError(error);
			return "";
		}
	},

	_formatNoteCell(value) {
		return this._escapeHTML(value || "").replace(/\r?\n/g, "<br>");
	},

	_setNoteStatus(session, text) {
		session?.noteStatus?.setAttribute("value", text || "");
	},

	_escapeHTML(value) {
		return String(value || "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},

	_destroySession(session, removeTab = true) {
		if (!session || !this.sessions.has(session.id)) return;
		try { session.noteEditor?.saveSync?.(); }
		catch (error) { Zotero.logError(error); }
		if (session.structuredData) this._writeJSONPref(session.structuredKey, session.structuredData);
		this._rememberPanelWidths(session);
		this._persistWorkspaceState(session);
		if (session.syncTimer) session.win.clearInterval(session.syncTimer);
		if (session.noteSaveTimer) session.win.clearTimeout(session.noteSaveTimer);
		for (let pane of session.panes) {
			pane.disposed = true;
			pane.pendingAttachment = null;
			pane.loadToken++;
			try { pane.preview?.uninit(); }
			catch (error) { Zotero.logError(error); }
		}
		session.root?.remove();
		this.sessions.delete(session.id);
		if (removeTab && session.win.Zotero_Tabs.getTabContent(session.tabID)) {
			session.win.Zotero_Tabs.close(session.tabID);
		}
	},

	_getActiveSession(win) {
		let tabID = win.Zotero_Tabs.selectedID;
		return this.sessions.get(tabID) || null;
	},

	_getWindowSession(win) {
		for (let session of this.sessions.values()) {
			if (session.win === win) return session;
		}
		return null;
	},

	_withSession(win, callback) {
		let session = this._getActiveSession(win) || this._getWindowSession(win);
		if (!session) {
			this._alert(win, "论文对比", "请先打开一个论文对比工作台。");
			return;
		}
		callback(session);
	},

	_getAlreadyOpenPDFAttachments(win) {
		let result = [];
		let seen = new Set();
		for (let reader of Zotero.Reader?._readers || []) {
			// ReaderPreview instances are not registered here. This intentionally
			// collects only the normal PDF tabs already visible above the workspace.
			if (reader._window && reader._window !== win) continue;
			let attachment = reader._item || Zotero.Items.get(reader.itemID);
			if (!attachment || seen.has(attachment.id) || attachment.deleted) continue;
			let isPDF = attachment.isPDFAttachment?.()
				|| attachment.attachmentContentType === "application/pdf";
			if (!isPDF) continue;
			seen.add(attachment.id);
			result.push(attachment);
		}
		return result;
	},

	_resolvePDFAttachments(items) {
		let result = [];
		let seen = new Set();
		let add = attachment => {
			if (!attachment || seen.has(attachment.id) || attachment.deleted) return;
			let isPDF = attachment.isPDFAttachment?.()
				|| attachment.attachmentContentType === "application/pdf";
			if (!isPDF) return;
			seen.add(attachment.id);
			result.push(attachment);
		};
		for (let item of items || []) {
			if (item.isAttachment?.()) {
				add(item);
				continue;
			}
			if (!item.isRegularItem?.()) continue;
			for (let id of item.getAttachments()) {
				let attachment = Zotero.Items.get(id);
				if (attachment?.isPDFAttachment?.()
					|| attachment?.attachmentContentType === "application/pdf") {
					add(attachment);
					break;
				}
			}
		}
		return result;
	},

	_getAttachmentTitle(attachment) {
		if (!attachment) return "未选择文献";
		let parent = attachment.parentItem;
		let title = parent?.getField?.("title") || attachment.getField?.("title") || attachment.attachmentFilename || "未命名 PDF";
		let creator = parent?.getField?.("firstCreator");
		let year = parent?.getField?.("date")?.match?.(/\d{4}/)?.[0];
		return [title, creator, year].filter(Boolean).join(" · ");
	},

	_readJSONPref(key, fallback) {
		try {
			let value = Zotero.Prefs.get(key, true);
			return value ? JSON.parse(value) : fallback;
		}
		catch (error) {
			Zotero.logError(error);
			return fallback;
		}
	},

	_writeJSONPref(key, value) {
		try { Zotero.Prefs.set(key, JSON.stringify(value), true); }
		catch (error) { Zotero.logError(error); }
	},

	_clampNumber(value, minimum, maximum, fallback) {
		let number = Number(value);
		if (!Number.isFinite(number)) number = fallback;
		return Math.min(maximum, Math.max(minimum, number));
	},

	_alert(win, title, message) {
		Services.prompt.alert(win || null, title, message);
	}
};
