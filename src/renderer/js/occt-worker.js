// Reads STEP, IGES and BREP files with OpenCascade (occt-import-js, fetched once into Dogfile's tools folder),
// away from the window so big assemblies never freeze it.
let occt = null;
self.onmessage = async (e) => {
  const { id, jsUrl, wasmUrl, buffer, format, params } = e.data;
  try {
    if (!occt) {
      importScripts(jsUrl);
      // eslint-disable-next-line no-undef
      occt = await occtimportjs({ locateFile: () => wasmUrl });
    }
    const result = occt.ReadFile(format, new Uint8Array(buffer), params);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
