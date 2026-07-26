const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "split-screen.js"), "utf8");
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
assert.match(source, /收回 ›/);

console.log("Core tests passed");
