export { EditorState, Compartment, StateEffect, StateField, EditorSelection, Transaction, Prec, RangeSetBuilder, RangeSet } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, highlightWhitespace, highlightTrailingWhitespace, placeholder, scrollPastEnd, Decoration, ViewPlugin, gutter, GutterMarker, WidgetType, hoverTooltip, showPanel } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, toggleComment, toggleBlockComment, copyLineDown, moveLineUp, moveLineDown, deleteLine, indentMore, indentLess, selectLine, cursorDocStart } from '@codemirror/commands';
export { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, StreamLanguage, LanguageDescription, indentUnit, defaultHighlightStyle, foldAll, unfoldAll } from '@codemirror/language';
export { search, searchKeymap, openSearchPanel, closeSearchPanel, findNext, findPrevious, gotoLine, highlightSelectionMatches, selectNextOccurrence, selectMatches, replaceAll, SearchQuery, setSearchQuery, getSearchQuery } from '@codemirror/search';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, completeAnyWord, snippetCompletion, startCompletion } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { php } from '@codemirror/lang-php';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { csharp, kotlin, dart, scala, objectiveC } from '@codemirror/legacy-modes/mode/clike';
import { vb } from '@codemirror/legacy-modes/mode/vb';
import { vbScript } from '@codemirror/legacy-modes/mode/vbscript';
import { fSharp } from '@codemirror/legacy-modes/mode/mllike';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { fortran } from '@codemirror/legacy-modes/mode/fortran';
import { pascal } from '@codemirror/legacy-modes/mode/pascal';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript';
import { stex } from '@codemirror/legacy-modes/mode/stex';
const S = (m) => () => StreamLanguage.define(m);
// Batch files: tiny custom mode
const batch = { name: 'batch', token(stream) {
  if (stream.sol() && stream.match(/^\s*(rem\b|::).*/i)) return 'comment';
  if (stream.match(/^%~?[\w]+%?|^![\w]+!/)) return 'variableName';
  if (stream.match(/^"[^"]*"?/)) return 'string';
  if (stream.match(/^\b(echo|set|if|else|for|in|do|goto|call|exit|setlocal|endlocal|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq|pushd|popd|cd|start|del|copy|move|mkdir|rmdir|title|cls|pause|shift)\b/i)) return 'keyword';
  if (stream.sol() && stream.match(/^\s*:\w+/)) return 'labelName';
  if (stream.match(/^@|^[<>|&]/)) return 'operator';
  stream.next(); return null; } };
const ini = properties;
export const LANGS = [
  { id: 'text', name: 'Normal text', ext: ['txt', 'log', 'nfo', 'text'], load: null },
  { id: 'js', name: 'JavaScript', ext: ['js', 'mjs', 'cjs', 'jsx'], load: () => javascript({ jsx: true }) },
  { id: 'ts', name: 'TypeScript', ext: ['ts', 'mts', 'cts', 'tsx'], load: () => javascript({ typescript: true, jsx: true }) },
  { id: 'json', name: 'JSON', ext: ['json', 'jsonc', 'json5', 'webmanifest', 'babelrc', 'eslintrc', 'prettierrc'], load: () => json() },
  { id: 'html', name: 'HTML', ext: ['html', 'htm', 'xhtml', 'vue', 'svelte', 'hta'], load: () => html() },
  { id: 'css', name: 'CSS', ext: ['css', 'scss', 'less', 'sass'], load: () => css() },
  { id: 'xml', name: 'XML', ext: ['xml', 'svg', 'xaml', 'csproj', 'vcxproj', 'props', 'targets', 'resx', 'plist', 'config', 'manifest', 'nuspec', 'xsd', 'xsl', 'rss', 'kml', 'gpx'], load: () => xml() },
  { id: 'md', name: 'Markdown', ext: ['md', 'markdown', 'mdx', 'mkd'], load: () => markdown() },
  { id: 'py', name: 'Python', ext: ['py', 'pyw', 'pyi', 'gyp'], load: () => python() },
  { id: 'c', name: 'C / C++', ext: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'cu'], load: () => cpp() },
  { id: 'cs', name: 'C#', ext: ['cs', 'csx'], load: S(csharp) },
  { id: 'java', name: 'Java', ext: ['java'], load: () => java() },
  { id: 'kt', name: 'Kotlin', ext: ['kt', 'kts'], load: S(kotlin) },
  { id: 'go', name: 'Go', ext: ['go'], load: () => go() },
  { id: 'rs', name: 'Rust', ext: ['rs'], load: () => rust() },
  { id: 'php', name: 'PHP', ext: ['php', 'phtml'], load: () => php() },
  { id: 'sql', name: 'SQL', ext: ['sql'], load: () => sql() },
  { id: 'yaml', name: 'YAML', ext: ['yml', 'yaml'], load: () => yaml() },
  { id: 'toml', name: 'TOML', ext: ['toml'], load: S(toml) },
  { id: 'ini', name: 'INI / Properties', ext: ['ini', 'cfg', 'conf', 'properties', 'inf', 'reg', 'editorconfig', 'gitconfig', 'env', 'desktop', 'url'], load: S(ini) },
  { id: 'ps1', name: 'PowerShell', ext: ['ps1', 'psm1', 'psd1'], load: S(powerShell) },
  { id: 'bat', name: 'Batch', ext: ['bat', 'cmd'], load: S(batch) },
  { id: 'sh', name: 'Shell', ext: ['sh', 'bash', 'zsh', 'fish', 'ksh', 'bashrc', 'zshrc', 'profile'], load: S(shell) },
  { id: 'lua', name: 'Lua', ext: ['lua'], load: S(lua) },
  { id: 'rb', name: 'Ruby', ext: ['rb', 'rake', 'gemspec'], load: S(ruby) },
  { id: 'pl', name: 'Perl', ext: ['pl', 'pm'], load: S(perl) },
  { id: 'r', name: 'R', ext: ['r'], load: S(r) },
  { id: 'swift', name: 'Swift', ext: ['swift'], load: S(swift) },
  { id: 'dart', name: 'Dart', ext: ['dart'], load: S(dart) },
  { id: 'scala', name: 'Scala', ext: ['scala', 'sc'], load: S(scala) },
  { id: 'objc', name: 'Objective-C', ext: ['m', 'mm'], load: S(objectiveC) },
  { id: 'vb', name: 'Visual Basic', ext: ['vb', 'bas', 'vba', 'cls', 'frm'], load: S(vb) },
  { id: 'vbs', name: 'VBScript', ext: ['vbs'], load: S(vbScript) },
  { id: 'fs', name: 'F#', ext: ['fs', 'fsx', 'fsi'], load: S(fSharp) },
  { id: 'hs', name: 'Haskell', ext: ['hs'], load: S(haskell) },
  { id: 'clj', name: 'Clojure', ext: ['clj', 'cljs', 'edn'], load: S(clojure) },
  { id: 'erl', name: 'Erlang', ext: ['erl', 'hrl'], load: S(erlang) },
  { id: 'jl', name: 'Julia', ext: ['jl'], load: S(julia) },
  { id: 'f90', name: 'Fortran', ext: ['f', 'f90', 'f95', 'for'], load: S(fortran) },
  { id: 'pas', name: 'Pascal', ext: ['pas', 'pp', 'dpr'], load: S(pascal) },
  { id: 'tcl', name: 'Tcl', ext: ['tcl'], load: S(tcl) },
  { id: 'v', name: 'Verilog', ext: ['v', 'sv', 'svh'], load: S(verilog) },
  { id: 'vhdl', name: 'VHDL', ext: ['vhd', 'vhdl'], load: S(vhdl) },
  { id: 'proto', name: 'Protocol Buffers', ext: ['proto'], load: S(protobuf) },
  { id: 'groovy', name: 'Groovy', ext: ['groovy', 'gradle'], load: S(groovy) },
  { id: 'coffee', name: 'CoffeeScript', ext: ['coffee'], load: S(coffeeScript) },
  { id: 'tex', name: 'LaTeX', ext: ['tex', 'sty', 'cls', 'bib'], load: S(stex) },
  { id: 'diff', name: 'Diff', ext: ['diff', 'patch'], load: S(diff) },
  { id: 'docker', name: 'Dockerfile', ext: ['dockerfile'], load: S(dockerFile) },
  { id: 'nginx', name: 'Nginx', ext: ['nginx'], load: S(nginx) },
  { id: 'cmake', name: 'CMake', ext: ['cmake'], load: S(cmake) },
];
export function langForName(name) {
  const low = name.toLowerCase();
  if (low === 'dockerfile' || low.startsWith('dockerfile.')) return LANGS.find((l) => l.id === 'docker');
  if (low === 'cmakelists.txt') return LANGS.find((l) => l.id === 'cmake');
  if (low === 'makefile') return LANGS.find((l) => l.id === 'sh');
  const e = low.includes('.') ? low.split('.').pop() : low.replace(/^\./, '');
  return LANGS.find((l) => l.ext.includes(e)) || LANGS[0];
}
export { MergeView, unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
