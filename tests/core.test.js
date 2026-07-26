const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "split-screen.js"), "utf8");
const stylesheet = fs.readFileSync(path.join(projectRoot, "workspace.css"), "utf8");
const itemsByID = new Map();
const context = {
	ZoteroSplitScreen: null,
	Zotero: {
		debug() {},
		Reader: { _readers: [] },
		Items: {
			get(id) {
				return itemsByID.get(id);
			}
		}
	},
	Services: {}
};

vm.runInNewContext(source, context, { filename: "split-screen.js" });
const plugin = context.ZoteroSplitScreen;

{
	const pdf1 = {
		id: 1,
		deleted: false,
		attachmentContentType: "application/pdf",
		isAttachment: () => true,
		isPDFAttachment: () => true
	};
	const textAttachment = {
		id: 2,
		deleted: false,
		attachmentContentType: "text/html",
		isAttachment: () => true,
		isPDFAttachment: () => false
	};
	const pdf2 = {
		id: 3,
		deleted: false,
		attachmentContentType: "application/pdf",
		isAttachment: () => true,
		isPDFAttachment: () => true
	};
	itemsByID.set(1, pdf1);
	itemsByID.set(2, textAttachment);
	itemsByID.set(3, pdf2);

	const parent1 = {
		isAttachment: () => false,
		isRegularItem: () => true,
		getAttachments: () => [2, 1]
	};
	const parent2 = {
		isAttachment: () => false,
		isRegularItem: () => true,
		getAttachments: () => [3]
	};
	const resolved = plugin._resolvePDFAttachments([parent1, pdf1, parent2]);
	assert.deepEqual(Array.from(resolved, item => item.id), [1, 3]);
}

{
	const session = { sources: [{ id: 1 }], maxSources: 3 };
	plugin.maxSources = 3;
	assert.equal(plugin._addSources(session, [{ id: 1 }, { id: 2 }, { id: 3 }]), true);
	assert.deepEqual(Array.from(session.sources, item => item.id), [1, 2, 3]);
	assert.equal(plugin._addSources(session, [{ id: 4 }]), false);
}

{
	const win = {};
	const pdf = {
		id: 10,
		deleted: false,
		attachmentContentType: "application/pdf",
		isPDFAttachment: () => true
	};
	const html = {
		id: 11,
		deleted: false,
		attachmentContentType: "text/html",
		isPDFAttachment: () => false
	};
	context.Zotero.Reader._readers = [
		{ _window: win, _item: pdf },
		{ _window: win, _item: pdf },
		{ _window: win, _item: html },
		{ _window: {}, _item: { ...pdf, id: 12 } }
	];
	assert.deepEqual(
		Array.from(plugin._getAlreadyOpenPDFAttachments(win), item => item.id),
		[10]
	);
}

{
	const note = "方法 A < 方法 B & 结果更稳定\n第二行";
	const html = plugin._formatNoteCell(note);
	assert.match(html, /&lt;/);
	assert.match(html, /&amp;/);
	assert.match(html, /<br>/);
}

assert.equal(plugin._clampNumber(10, 20, 40, 30), 20);
assert.equal(plugin._clampNumber(50, 20, 40, 30), 40);
assert.equal(plugin._clampNumber("bad", 20, 40, 30), 30);
assert.equal(plugin._getResponsiveNotesMaximum({ innerWidth: 2048 }), 680);
assert.equal(plugin._getResponsiveNotesMaximum({ innerWidth: 900 }), 432);
assert.equal(plugin._getResponsiveNotesMaximum({ innerWidth: 500 }), 320);

{
	const originalApply = plugin._applyPanelState;
	const originalSchedule = plugin._scheduleRelationOverlay;
	plugin._applyPanelState = () => {};
	plugin._scheduleRelationOverlay = () => {};
	let compact = false;
	const responsiveSession = {
		root: {
			isConnected: true,
			toggleAttribute(_name, enabled) { compact = enabled; }
		},
		content: { getBoundingClientRect: () => ({ width: 1000 }) },
		win: { innerWidth: 1000 },
		notesCollapsed: false,
		notesWidth: 600,
		notesWidthRatio: 0.4
	};
	plugin._adaptWorkspaceToSize(responsiveSession);
	assert.equal(responsiveSession.notesWidth, 400);
	assert.equal(compact, true);
	responsiveSession.content.getBoundingClientRect = () => ({ width: 2000 });
	responsiveSession.win.innerWidth = 2000;
	plugin._adaptWorkspaceToSize(responsiveSession);
	assert.equal(responsiveSession.notesWidth, 680);
	assert.equal(compact, false);
	plugin._applyPanelState = originalApply;
	plugin._scheduleRelationOverlay = originalSchedule;
}

assert.equal(plugin._getWorkspaceAvailableWidth({
	win: { innerWidth: 1536 },
	container: { clientWidth: 2200, getBoundingClientRect: () => ({ width: 2200 }) },
	content: { clientWidth: 2100, getBoundingClientRect: () => ({ width: 2100 }) }
}), 1536);

{
	const relations = plugin._sanitizeRelations([{
		id: "relation-1",
		type: "contradict",
		label: "结论矛盾",
		start: { attachmentID: 1, pageIndex: 2, quote: "A conclusion", x: -2, y: 0.4 },
		end: { attachmentID: 3, pageIndex: 8, quote: "B conclusion", x: 3, y: 0.7 }
	}]);
	assert.equal(relations.length, 1);
	assert.equal(relations[0].type, "contradict");
	assert.equal(relations[0].start.x, 0);
	assert.equal(relations[0].end.x, 1);
	assert.equal(plugin._getRelationType("missing").id, "custom");
	assert.equal(plugin._sanitizeRelations([{ start: null, end: null }]).length, 0);
}

{
	const dropped = plugin._extractDroppedComparisonText({
		dataTransfer: {
			getData(type) {
				if (type === "zotero/annotation") {
					return JSON.stringify([{ text: "关键方法", pageLabel: "12" }]);
				}
				return "";
			}
		}
	}, "A");
	assert.equal(dropped, "[A p.12] 关键方法");
}

assert.match(source, /readerInstancePrototype\._open\.call\(preview, \{ preview: false \}\)/);
assert.match(source, /this\._addSources\(session, attachments\)/);
assert.doesNotMatch(source, /session\.sources\s*=\s*attachments\.slice/);
assert.match(source, /editor\.mode\s*=\s*"edit"/);
assert.match(source, /_makeNativeNoteResponsive\(editor\)/);
assert.match(source, /zss-responsive-note-style/);
assert.match(source, /_installRelationSelectionTracking/);
assert.match(source, /_renderRelationOverlay/);
assert.match(source, /extensions\.zotero-split-screen\.relations/);
assert.match(source, /addEventListener\("selectionchange", captureNow, true\)/);
assert.match(source, /addEventListener\("pointerup", capture, true\)/);
assert.match(source, /pane\.relationButton\?\.removeAttribute\("disabled"\)/);
assert.doesNotMatch(source, /Services\.prompt\.select/);
assert.match(source, /zss-relation-type-select/);
assert.match(source, /zss-relation-label-input/);
assert.match(source, /new session\.win\.ResizeObserver/);
assert.match(source, /notesWidthRatio/);
assert.match(source, /data-zss-compact/);
assert.match(source, /_beginNotesResize/);
assert.doesNotMatch(source, /svg\.setAttribute\("width"/);
assert.doesNotMatch(source, /svg\.setAttribute\("height"/);
assert.match(source, /session\.relationOverlay\?\.remove\(\)/);
assert.match(stylesheet, /\.zss-relation-overlay\s*\{[\s\S]*?width:\s*100%/);
assert.match(stylesheet, /\.zss-notes\s*\{[\s\S]*?max-width:\s*min\(48vw, 680px\)/);
assert.match(stylesheet, /\.zss-reader-grid\s*\{[\s\S]*?width:\s*0;/);
assert.match(stylesheet, /\.zss-grid-row\[orient="horizontal"\]\s*>\s*\.zss-reader-pane/);
assert.match(stylesheet, /\.zss-workspace\[data-zss-compact\]\s+\.zss-notes/);
assert.match(source, /收回 ›/);

console.log("Core tests passed");
