// CCS/1 UI text, English + Polish. Every user-facing string in src/ lives here.
// RULE:pl typed as `typeof en` -> tsc rejects a missing/extra key; scripts/i18n-check.mjs checks shapes + stray text
// LANG:start=localStorage (no flash) then backend get_settings().lang (saved choice ?? Windows UI language)

export type Lang = "en" | "pl";

/** Polish plural: 1 → one, 2-4 (not 12-14) → few, else many. */
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const pliki = (n: number) => `${n} ${plural(n, "plik", "pliki", "plików")}`;

const en = {
  // ---- Navigation
  nav: "Navigation",
  folders: "Folders", rules: "Rules", preview: "Preview", activity: "Activity", settings: "Settings", about: "About",
  // ---- Folders
  foldersLede: "FolderPilot watches these folders and applies your rules to files that land in them.",
  addFolder: "Add folder",
  foldersEmpty: "Add a folder, such as Downloads, and FolderPilot keeps it tidy.",
  watch: (path: string) => `Watch ${path}`,
  stopWatching: (path: string) => `Stop watching ${path}`,
  stoppedWatching: (name: string) => `Stopped watching ${name}.`,
  undo: "Undo",
  pausedTitle: "All folders are paused.", pausedText: "New files are left alone until you resume.", resume: "Resume",
  // ---- Rules
  rulesLede: "Rules run top to bottom and the first match wins. Drag a rule by its handle to reorder.",
  newRule: "New rule", blankRule: "Blank rule",
  rulesEmpty: "No rules yet. Use New rule to start from an example or from a blank rule.",
  untitled: "Untitled rule",
  enable: (name: string) => `Enable ${name}`,
  reorder: (name: string) => `Move ${name}; use the arrow keys`,
  edit: (name: string) => `Edit ${name}`,
  remove: (name: string) => `Delete ${name}`,
  deleted: (name: string) => `Deleted ${name}.`,
  starters: { pdf: "PDFs to Documents", photos: "Photos by date", rename: "Rename with date", archive: "Archive files older than 90 days" },
  typeIs: (list: string) => `Type is ${list}`,
  nameIs: (glob: string) => `Name matches “${glob}”`,
  olderIs: (n: number) => `Older than ${n} ${n === 1 ? "day" : "days"}`,
  biggerIs: (mb: string) => `Bigger than ${mb} MB`,
  smallerIs: (mb: string) => `Smaller than ${mb} MB`,
  anyFile: "Any file", and: " and ",
  inFolders: (list: string) => ` in ${list}`,
  moveTo: (path: string) => `Move to ${path}`,
  renameTo: (name: string) => `Rename to ${name}`,
  // ---- Editor
  editTitle: "Edit rule", newTitle: "New rule",
  name: "Name",
  whenIn: "When a file is in",
  allFolders: "All folders",
  conds: { ext: "Type is", name_glob: "Name matches", older_than_days: "Older than", min_size: "Bigger than", max_size: "Smaller than" },
  condMenu: { ext: "File type", name_glob: "Name matches", older_than_days: "Older than", min_size: "Bigger than", max_size: "Smaller than" },
  days: "days", mb: "MB",
  globHint: "* is any text, ? one character",
  addCondition: "Add condition", removeCondition: "Remove condition",
  then: "Then",
  actions: { move_to: "Move to", rename: "Rename to" },
  folderField: "Target folder", nameField: "New name",
  tokensFolder: "Insert into the folder", tokensName: "Insert into the name",
  example: "Example",
  cancel: "Cancel", tryIt: "Preview", saveRule: "Save rule",
  // ---- Preview
  previewLede: "See what your rules would do. Nothing moves until you apply.",
  previewOf: "Rules to preview", allEnabled: "All enabled rules",
  unsaved: (name: string) => `${name} (unsaved)`,
  runPreview: "Run preview", apply: "Apply",
  previewEmpty: "Pick rules and run a preview.",
  noMatches: "No files match these rules right now.",
  wouldMove: (n: number) => `${files(n)} would move`,
  // ---- Activity
  activityLede: "Every move and rename is recorded here, and each run can be undone.",
  activityEmpty: "No moves yet.",
  moved: (n: number) => `${files(n)} moved`,
  movedBack: (n: number) => `Undo: ${files(n)} moved back`,
  undone: "Undone",
  // ---- Settings
  general: "General",
  startWithWindows: "Start with Windows", startText: "FolderPilot starts in the tray when you sign in",
  language: "Language", languageText: "Language of the window, tray menu and messages",
  theme: "Theme", themeText: "As in Windows, or one you choose", themes: { system: "Use system setting", light: "Light", dark: "Dark" },
  pauseAll: "Pause all folders", pauseText: "No file is moved while this is on; the tray menu has the same switch",
  advanced: "Advanced",
  dataFolder: "Data folder", dataFolderText: "Rules, watched folders and the journal that makes undo possible",
  openFolder: "Open folder",
  on: "On", off: "Off",
  // ---- About
  version: (v: string) => `Version ${v}`,
  aboutText: "Open-source automatic file organiser for Windows.",
  projectPage: "Project page", source: "Source code", issues: "Report a problem", licence: "MIT licence",
  // ---- Messages
  dismiss: "Close",
  saveFailed: "The change was not saved.", loadFailed: "FolderPilot could not read its data.",
  previewFailed: "The preview did not run.", applyFailed: "Some files were left where they were.",
  undoFailed: "Some files were not moved back.", openFailed: "That could not be opened.",
  actionFailed: "That did not work.",
};

const pl: typeof en = {
  nav: "Nawigacja",
  folders: "Foldery", rules: "Reguły", preview: "Podgląd", activity: "Historia", settings: "Ustawienia", about: "O aplikacji",
  foldersLede: "FolderPilot obserwuje te foldery i stosuje Twoje reguły do plików, które do nich trafiają.",
  addFolder: "Dodaj folder",
  foldersEmpty: "Dodaj folder, na przykład Pobrane, a FolderPilot utrzyma w nim porządek.",
  watch: (path) => `Obserwuj ${path}`,
  stopWatching: (path) => `Przestań obserwować ${path}`,
  stoppedWatching: (name) => `Folder ${name} nie jest już obserwowany.`,
  undo: "Cofnij",
  pausedTitle: "Wszystkie foldery są wstrzymane.", pausedText: "Nowe pliki zostają na miejscu, dopóki nie wznowisz.", resume: "Wznów",
  rulesLede: "Reguły działają od góry do dołu i wygrywa pierwsza pasująca. Przeciągnij regułę za uchwyt, aby zmienić kolejność.",
  newRule: "Nowa reguła", blankRule: "Pusta reguła",
  rulesEmpty: "Nie ma jeszcze reguł. Wybierz Nowa reguła, aby zacząć od przykładu albo od pustej reguły.",
  untitled: "Reguła bez nazwy",
  enable: (name) => `Włącz ${name}`,
  reorder: (name) => `Przenieś ${name}; użyj strzałek`,
  edit: (name) => `Edytuj ${name}`,
  remove: (name) => `Usuń ${name}`,
  deleted: (name) => `Usunięto ${name}.`,
  starters: { pdf: "PDF-y do Dokumentów", photos: "Zdjęcia według daty", rename: "Data w nazwie", archive: "Archiwizuj pliki starsze niż 90 dni" },
  typeIs: (list) => `Typ to ${list}`,
  nameIs: (glob) => `Nazwa pasuje do „${glob}”`,
  olderIs: (n) => `Starszy niż ${n} ${n === 1 ? "dzień" : "dni"}`,
  biggerIs: (mb) => `Większy niż ${mb} MB`,
  smallerIs: (mb) => `Mniejszy niż ${mb} MB`,
  anyFile: "Każdy plik", and: " i ",
  inFolders: (list) => ` w ${list}`,
  moveTo: (path) => `Przenieś do ${path}`,
  renameTo: (name) => `Zmień nazwę na ${name}`,
  editTitle: "Edycja reguły", newTitle: "Nowa reguła",
  name: "Nazwa",
  whenIn: "Gdy plik jest w",
  allFolders: "Wszystkie foldery",
  conds: { ext: "Typ to", name_glob: "Nazwa pasuje do", older_than_days: "Starszy niż", min_size: "Większy niż", max_size: "Mniejszy niż" },
  condMenu: { ext: "Typ pliku", name_glob: "Nazwa pasuje do", older_than_days: "Starszy niż", min_size: "Większy niż", max_size: "Mniejszy niż" },
  days: "dni", mb: "MB",
  globHint: "* to dowolny tekst, ? jeden znak",
  addCondition: "Dodaj warunek", removeCondition: "Usuń warunek",
  then: "Wtedy",
  actions: { move_to: "Przenieś do", rename: "Zmień nazwę na" },
  folderField: "Folder docelowy", nameField: "Nowa nazwa",
  tokensFolder: "Wstaw do folderu", tokensName: "Wstaw do nazwy",
  example: "Przykład",
  cancel: "Anuluj", tryIt: "Podgląd", saveRule: "Zapisz regułę",
  previewLede: "Zobacz, co zrobiłyby reguły. Nic nie zostanie przeniesione, dopóki nie zastosujesz.",
  previewOf: "Reguły do podglądu", allEnabled: "Wszystkie włączone reguły",
  unsaved: (name) => `${name} (niezapisana)`,
  runPreview: "Uruchom podgląd", apply: "Zastosuj",
  previewEmpty: "Wybierz reguły i uruchom podgląd.",
  noMatches: "Żaden plik nie pasuje teraz do tych reguł.",
  wouldMove: (n) => `${pliki(n)} do przeniesienia`,
  activityLede: "Każde przeniesienie i zmiana nazwy są tu zapisane, a każde uruchomienie można cofnąć.",
  activityEmpty: "Jeszcze nic nie przeniesiono.",
  moved: (n) => `Przeniesiono: ${pliki(n)}`,
  movedBack: (n) => `Cofnięcie: przywrócono ${pliki(n)}`,
  undone: "Cofnięto",
  general: "Ogólne",
  startWithWindows: "Uruchamiaj z Windows", startText: "FolderPilot uruchamia się w zasobniku po zalogowaniu",
  language: "Język", languageText: "Język okna, menu w zasobniku i komunikatów",
  theme: "Motyw", themeText: "Jak w Windows albo wybrany", themes: { system: "Jak w systemie", light: "Jasny", dark: "Ciemny" },
  pauseAll: "Wstrzymaj wszystkie foldery", pauseText: "Gdy to jest włączone, żaden plik nie jest przenoszony; menu w zasobniku ma ten sam przełącznik",
  advanced: "Zaawansowane",
  dataFolder: "Folder danych", dataFolderText: "Reguły, obserwowane foldery i dziennik, dzięki któremu działa cofanie",
  openFolder: "Otwórz folder",
  on: "Wł.", off: "Wył.",
  version: (v) => `Wersja ${v}`,
  aboutText: "Otwartoźródłowy, automatyczny organizer plików dla Windows.",
  projectPage: "Strona projektu", source: "Kod źródłowy", issues: "Zgłoś problem", licence: "Licencja MIT",
  dismiss: "Zamknij",
  saveFailed: "Zmiana nie została zapisana.", loadFailed: "FolderPilot nie wczytał swoich danych.",
  previewFailed: "Podgląd się nie uruchomił.", applyFailed: "Część plików została na miejscu.",
  undoFailed: "Części plików nie przywrócono.", openFailed: "Nie udało się tego otworzyć.",
  actionFailed: "To się nie udało.",
};

export const dictionaries = { en, pl };
export let lang: Lang = "en";
export let t: typeof en = en;

/** Switches every later `t.*` read; callers re-render. */
export function setLang(next: Lang) {
  lang = next;
  t = next === "pl" ? pl : en;
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/** Windows UI language for a first start: Polish stays Polish, anything else is English. */
export function systemLang(): Lang {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
}
