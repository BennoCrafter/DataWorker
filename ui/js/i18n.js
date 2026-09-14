/**
 * English/German translations for the whole UI. `t(key, vars)` looks up the current language
 * (persisted in config.language, defaulting to German since that's the app's original language)
 * and falls back to English, then the key itself, if a string is missing.
 *
 * Modules that render translated text call onLanguageChange(rerenderFn) once at load so a
 * language switch (from the Settings toggle) re-renders them immediately.
 */
import { config, saveConfig } from "./config.js";

const STRINGS = {
	en: {
		"sidebar.title": "Libraries",
		"sidebar.importCsv": "Import CSV…",
		"sidebar.newLibrary": "New Library…",
		"sidebar.empty": "No library yet. Use + to create one or import an old Bento export.",
		"topbar.settings": "Settings",

		"fieldType.text": "Text",
		"fieldType.note": "Note",
		"fieldType.number": "Number",
		"fieldType.currency": "Currency",
		"fieldType.date": "Date",
		"fieldType.boolean": "Yes/No",

		"library.noneSelectedTitle": "No library selected",
		"library.noneSelectedSub": "Create a library on the left, or import a Bento export.",
		"library.entriesCount": "{count} entries",
		"library.searchPlaceholder": "Search…",
		"library.manageFieldsTitle": "Manage Fields…",
		"library.exportCsvTitle": "Export as CSV…",
		"library.newRecord": "New Entry",
		"library.resetColumnWidthTitle": "Double-click to reset width",
		"library.resetRowHeightTitle": "Double-click to reset row height",

		"record.openTitle": "Open entry",
		"record.deleteTitle": "Delete entry",
		"record.deleteButton": "Delete Entry",
		"record.fallbackTitle": "Entry",
		"record.confirmDelete": 'Delete "{title}"?',
		"record.meta": "Created {created} · Updated {updated}",

		"toast.exportedTo": "Exported to {path}",
		"toast.exportFailed": "Export failed",
		"toast.chooseCsv": "Choose a CSV file…",
		"toast.imported": '"{name}" imported ({count} entries)',
		"toast.importFailed": "Import failed",

		"modal.manageFields": "Manage Fields",
		"modal.newLibrary": "New Library",
		"modal.libraryNamePlaceholder": "Library name",
		"modal.fieldsLabel": "Fields",
		"modal.addField": "Add Field",
		"modal.deleteLibrary": "Delete Library",
		"modal.confirmDeleteLibrary": 'Delete "{name}" and all {count} entries?',
		"modal.fieldNamePlaceholder": "Field name",

		"error.nameRequired": "Please enter a name.",
		"error.fieldRequired": "At least one field is required.",
		"error.saveFailed": "Save failed.",
		"error.createFailed": "Create failed.",

		"common.cancel": "Cancel",
		"common.save": "Save",
		"common.create": "Create",
		"common.delete": "Delete",
		"common.done": "Done",
		"common.yes": "Yes",

		"settings.title": "Settings",
		"settings.loading": "Loading…",
		"settings.language": "Language",
		"settings.appSection": "App",
		"settings.version": "Version",
		"settings.runningFromSource": "running from source",
		"settings.platform": "Platform",
		"settings.checkForUpdates": "Check for Updates",
		"settings.checking": "Checking…",
		"settings.repoUnreachable": "The repository is not reachable.",
		"settings.restartToFinish": "An update is already installed — restart to finish.",
		"settings.restartNow": "Restart Now",
		"settings.upToDate": "Everything is up to date.",
		"settings.authFailed": "The update check could not authenticate — see the credentials section below.",
		"settings.checkFailed": "The update check failed: {reason}",
		"settings.install": "Install",
		"settings.available": "Available: {list}",
		"theme.light": "Light",
		"theme.dark": "Dark",

		"activity.failed": "Failed",
		"activity.idle": "Idle · Ready",
		"activity.title": "Activity",
		"activity.nothingRunning": "Nothing running.",
		"activity.reveal": "Reveal",

		"update.headerLabel": "Update",
		"update.headerRestartLabel": "Restart",
		"update.availableTooltip": "Update available: {list} — downloads and installs",
		"update.restartTooltip": "Update to build {version} installed — restart to finish",
		"update.restartToFinishTooltip": "Restart to finish the update",
		"update.appUpdateTitle": "App Update",
		"update.restarting": "Restarting…",
		"update.restartFailed": "restart failed",
		"update.downloading": "Downloading updates…",
		"update.updateFailed": "update failed",
		"update.installedRestartWhenReady": "Update to build {version} installed — restart when it suits you.",
		"update.ready": "Ready",

		"status.buildTooltip": "build {version}",
	},
	de: {
		"sidebar.title": "Bibliotheken",
		"sidebar.importCsv": "CSV importieren…",
		"sidebar.newLibrary": "Neue Bibliothek…",
		"sidebar.empty": "Noch keine Bibliothek. Mit + eine neue anlegen oder einen alten Bento-Export importieren.",
		"topbar.settings": "Einstellungen",

		"fieldType.text": "Text",
		"fieldType.note": "Notiz",
		"fieldType.number": "Zahl",
		"fieldType.currency": "Betrag",
		"fieldType.date": "Datum",
		"fieldType.boolean": "Ja/Nein",

		"library.noneSelectedTitle": "Keine Bibliothek ausgewählt",
		"library.noneSelectedSub": "Links eine Bibliothek anlegen oder einen Bento-Export importieren.",
		"library.entriesCount": "{count} Einträge",
		"library.searchPlaceholder": "Suchen…",
		"library.manageFieldsTitle": "Felder verwalten…",
		"library.exportCsvTitle": "Als CSV exportieren…",
		"library.newRecord": "Neuer Eintrag",
		"library.resetColumnWidthTitle": "Doppelklick setzt die Breite zurück",
		"library.resetRowHeightTitle": "Doppelklick setzt die Zeilenhöhe zurück",

		"record.openTitle": "Eintrag öffnen",
		"record.deleteTitle": "Eintrag löschen",
		"record.deleteButton": "Eintrag löschen",
		"record.fallbackTitle": "Eintrag",
		"record.confirmDelete": '"{title}" löschen?',
		"record.meta": "Erstellt {created} · Geändert {updated}",

		"toast.exportedTo": "Exportiert nach {path}",
		"toast.exportFailed": "Export fehlgeschlagen",
		"toast.chooseCsv": "CSV-Datei wählen…",
		"toast.imported": '"{name}" importiert ({count} Einträge)',
		"toast.importFailed": "Import fehlgeschlagen",

		"modal.manageFields": "Felder verwalten",
		"modal.newLibrary": "Neue Bibliothek",
		"modal.libraryNamePlaceholder": "Name der Bibliothek",
		"modal.fieldsLabel": "Felder",
		"modal.addField": "Feld hinzufügen",
		"modal.deleteLibrary": "Bibliothek löschen",
		"modal.confirmDeleteLibrary": '"{name}" und alle {count} Einträge löschen?',
		"modal.fieldNamePlaceholder": "Feldname",

		"error.nameRequired": "Bitte einen Namen eingeben.",
		"error.fieldRequired": "Mindestens ein Feld wird benötigt.",
		"error.saveFailed": "Speichern fehlgeschlagen.",
		"error.createFailed": "Erstellen fehlgeschlagen.",

		"common.cancel": "Abbrechen",
		"common.save": "Speichern",
		"common.create": "Erstellen",
		"common.delete": "Löschen",
		"common.done": "Fertig",
		"common.yes": "Ja",

		"settings.title": "Einstellungen",
		"settings.loading": "Lädt…",
		"settings.language": "Sprache",
		"settings.appSection": "App",
		"settings.version": "Version",
		"settings.runningFromSource": "läuft aus dem Quellcode",
		"settings.platform": "Plattform",
		"settings.checkForUpdates": "Nach Updates suchen",
		"settings.checking": "Suche läuft…",
		"settings.repoUnreachable": "Das Repository ist nicht erreichbar.",
		"settings.restartToFinish": "Ein Update ist bereits installiert — zum Abschließen neu starten.",
		"settings.restartNow": "Jetzt neu starten",
		"settings.upToDate": "Alles ist auf dem neuesten Stand.",
		"settings.authFailed": "Die Update-Prüfung konnte sich nicht authentifizieren — siehe Anmeldedaten unten.",
		"settings.checkFailed": "Die Update-Prüfung ist fehlgeschlagen: {reason}",
		"settings.install": "Installieren",
		"settings.available": "Verfügbar: {list}",
		"theme.light": "Hell",
		"theme.dark": "Dunkel",

		"activity.failed": "Fehlgeschlagen",
		"activity.idle": "Bereit",
		"activity.title": "Aktivität",
		"activity.nothingRunning": "Nichts läuft gerade.",
		"activity.reveal": "Anzeigen",

		"update.headerLabel": "Update",
		"update.headerRestartLabel": "Neu starten",
		"update.availableTooltip": "Update verfügbar: {list} — wird heruntergeladen und installiert",
		"update.restartTooltip": "Update auf Build {version} installiert — zum Abschließen neu starten",
		"update.restartToFinishTooltip": "Zum Abschließen des Updates neu starten",
		"update.appUpdateTitle": "App-Update",
		"update.restarting": "Wird neu gestartet…",
		"update.restartFailed": "Neustart fehlgeschlagen",
		"update.downloading": "Updates werden heruntergeladen…",
		"update.updateFailed": "Update fehlgeschlagen",
		"update.installedRestartWhenReady": "Update auf Build {version} installiert — neu starten, wann es passt.",
		"update.ready": "Bereit",

		"status.buildTooltip": "Build {version}",
	},
};

const listeners = new Set();

/** If config.language is set, returns it; otherwise, returns the browser's language if it starts with "de", otherwise "en". */
export function currentLanguage() {
  // this is just bad code lol
  if (config.language == "de" || config.language == "en") {
    return config.language;
  }
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function setLanguage(lang) {
	const next = lang === "en" ? "en" : "de";
	if (next === currentLanguage()) return;
	config.language = next;
	saveConfig();
	document.documentElement.lang = next;
	for (const listener of listeners) listener();
}

/** Registers a re-render callback to run whenever the language changes. */
export function onLanguageChange(listener) {
	listeners.add(listener);
}

export function t(key, vars) {
	const dict = STRINGS[currentLanguage()];
	let str = dict[key] ?? STRINGS.en[key] ?? key;
	if (vars) {
		for (const [name, value] of Object.entries(vars)) str = str.replaceAll(`{${name}}`, value);
	}
	return str;
}

/** Applies translations to every static [data-i18n(-title|-placeholder)] element in the DOM. */
export function applyStaticTranslations(root = document) {
	document.documentElement.lang = currentLanguage();
	for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
	for (const node of root.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
	for (const node of root.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
}
