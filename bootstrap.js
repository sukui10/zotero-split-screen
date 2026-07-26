var ZoteroSplitScreen;

function log(message) {
	Zotero.debug("Zotero Split Screen: " + message);
}

function install() {
	log("installed");
}

async function startup({ id, version, rootURI }) {
	log("starting " + version);
	Services.scriptloader.loadSubScript(rootURI + "split-screen.js");
	ZoteroSplitScreen.init({ id, version, rootURI });
	ZoteroSplitScreen.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	ZoteroSplitScreen?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	ZoteroSplitScreen?.removeFromWindow(window);
}

function shutdown(_data, reason) {
	if (reason === APP_SHUTDOWN) return;
	log("shutting down");
	ZoteroSplitScreen?.shutdown();
	ZoteroSplitScreen = undefined;
}

function uninstall() {
	log("uninstalled");
}
