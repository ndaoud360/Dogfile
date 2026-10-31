// Libraries for Dogfile Office (Word, Excel, PowerPoint and PDF files).
// Rebuild: npx esbuild build/vendor-src/office.js --bundle --format=esm --minify --legal-comments=eof --outfile=src/renderer/vendor/office.js
// (pdf.js ships prebuilt: copy node_modules/pdfjs-dist/build/pdf.min.mjs and pdf.worker.min.mjs to src/renderer/vendor/pdfjs/)
export * as docx from 'docx';
export { default as JSZip } from 'jszip';
export * as XLSX from 'xlsx';
export * as PDFLib from 'pdf-lib';
import mammoth from 'mammoth/mammoth.browser.js';
export { mammoth };
