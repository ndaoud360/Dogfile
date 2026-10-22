// What's Dogfile Pro: the features, the commands, and menu labels that get a star. No imports, so any module
// (menus included) can use it. license.js has the checks and the popups.
export const FEATURES = {
  assistant: 'The AI assistant',
  panes: 'Three and four panes',
  compare: 'Folder compare and sync',
  rename: 'The batch rename studio',
  dupes: 'The duplicate and similar-file finders',
  space: 'The disk space map and cleanup',
  automation: 'Automations and macros',
  versions: 'File versions',
  remote: 'Cloud, SFTP and FTP connections',
  convert: 'Media conversion',
  ocr: 'Reading text in images (OCR)',
  features: 'Custom features',
};
export const PLURAL = new Set(['panes', 'dupes', 'space', 'automation', 'versions', 'remote', 'features']);
export const PRO_COMMANDS = {
  assistant: 'assistant', aiModels: 'assistant',
  layout3: 'panes', layout4: 'panes',
  compare: 'compare',
  batchRename: 'rename', renameWords: 'rename',
  dupes: 'dupes', similarImages: 'dupes', similarMedia: 'dupes',
  analyze: 'space', analyzeSelection: 'space', cleanup: 'space',
  declutter: 'automation', startMacro: 'automation', macros: 'automation', folderRules: 'automation', automations: 'automation',
  versions: 'versions', allVersions: 'versions',
  connections: 'remote', addConnection: 'remote',
  contactSheet: 'convert',
  features: 'features', createFeature: 'features', featureStore: 'features',
};
// menu items built without a command id get their star from the label
const PRO_LABELS = [
  [/^(batch rename|rename studio|rename with words|rename using)/i, 'rename'],
  [/^(convert|contact sheet)/i, 'convert'],
  [/(extract|read|copy) text (from|in) (the )?(image|picture|photo)|^ocr\b/i, 'ocr'],
  [/^(find )?(duplicates|similar)/i, 'dupes'],
  [/^compare (folders|with)/i, 'compare'],
  [/^(analy[sz]e (space|disk|folder size)|disk space|storage cleanup)/i, 'space'],
  [/^(versions|save a version|file versions|keep versions)/i, 'versions'],
  [/^(automations?|folder rules|record a macro|macros)/i, 'automation'],
  [/^(ask the (file )?assistant|ask dogfile)/i, 'assistant'],
];
export const proForLabel = (label) => (PRO_LABELS.find(([re]) => re.test(label || '')) || [])[1] || null;
export const starHtml = '<span class="pro-star" title="Dogfile Pro">★</span>';
